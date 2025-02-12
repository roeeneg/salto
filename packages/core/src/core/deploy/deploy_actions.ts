/*
*                      Copyright 2023 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import _ from 'lodash'
import {
  AdapterOperations, getChangeData, Change,
  isAdditionOrModificationChange, DeployResult, DeployExtraProperties, DeployOptions,
} from '@salto-io/adapter-api'
import { detailedCompare, applyDetailedChanges } from '@salto-io/adapter-utils'
import { WalkError, NodeSkippedError } from '@salto-io/dag'
import { logger } from '@salto-io/logging'
import { Plan, PlanItem, PlanItemId } from '../plan'

const log = logger(module)

type DeployOrValidateParams = {
  adapter: AdapterOperations
  adapterName: string
  opts: DeployOptions
  checkOnly: boolean
}

const deployOrValidate = (
  { adapter, adapterName, opts, checkOnly }: DeployOrValidateParams
): Promise<DeployResult> => {
  if (!checkOnly) {
    return adapter.deploy(opts)
  }
  if (_.isUndefined(adapter.validate)) {
    throw new Error(`Check-Only deployment is not supported in adapter ${adapterName}`)
  }
  return adapter.validate(opts)
}

const deployAction = (
  planItem: PlanItem,
  adapters: Record<string, AdapterOperations>,
  checkOnly: boolean
): Promise<DeployResult> => {
  const changes = [...planItem.changes()]
  const adapterName = getChangeData(changes[0]).elemID.adapter
  const adapter = adapters[adapterName]
  if (!adapter) {
    throw new Error(`Missing adapter for ${adapterName}`)
  }
  const opts = { changeGroup: { groupID: planItem.groupKey, changes } }
  return deployOrValidate({ adapter, adapterName, opts, checkOnly })
}

export class DeployError extends Error {
  constructor(readonly elementId: string | string[], message: string) {
    super(message)
  }
}

export type ItemStatus = 'started' | 'finished' | 'error' | 'cancelled'

export type StepEvents<T = void> = {
  completed: (params: T) => void
  failed: (errorText?: string) => void
}

type DeployActionResult = {
  errors: DeployError[]
  appliedChanges: Change[]
  extraProperties: Required<DeployExtraProperties>
}

const updatePlanElement = (item: PlanItem, appliedChanges: ReadonlyArray<Change>): void => {
  const planElementById = _.keyBy(
    [...item.items.values()].map(getChangeData),
    changeData => changeData.elemID.getFullName()
  )
  appliedChanges
    .filter(isAdditionOrModificationChange)
    .map(getChangeData)
    .forEach(updatedElement => {
      const planElement = planElementById[updatedElement.elemID.getFullName()]
      if (planElement !== undefined) {
        applyDetailedChanges(planElement, detailedCompare(planElement, updatedElement))
      }
    })
}

export const deployActions = async (
  deployPlan: Plan,
  adapters: Record<string, AdapterOperations>,
  reportProgress: (item: PlanItem, status: ItemStatus, details?: string) => void,
  postDeployAction: (appliedChanges: ReadonlyArray<Change>) => Promise<void>,
  checkOnly: boolean
): Promise<DeployActionResult> => {
  const appliedChanges: Change[] = []
  const deploymentUrls: string[] = []
  try {
    await deployPlan.walkAsync(async (itemId: PlanItemId): Promise<void> => {
      const item = deployPlan.getItem(itemId) as PlanItem
      reportProgress(item, 'started')
      try {
        const result = await deployAction(item, adapters, checkOnly)
        result.appliedChanges.forEach(appliedChange => appliedChanges.push(appliedChange))
        if (result.extraProperties?.deploymentUrls !== undefined) {
          deploymentUrls.push(...result.extraProperties.deploymentUrls)
        }
        // Update element with changes so references to it
        // will have an updated version throughout the deploy plan
        updatePlanElement(item, result.appliedChanges)
        await postDeployAction(result.appliedChanges)
        if (result.errors.length > 0) {
          log.warn(
            'Failed to deploy %s, errors: %s',
            item.groupKey,
            result.errors.map(err => err.stack ?? err.message).join('\n\n'),
          )
          throw new Error(
            `Failed to ${checkOnly ? 'validate' : 'deploy'} ${item.groupKey} with errors:\n${result.errors.join('\n')}`
          )
        }
        reportProgress(item, 'finished')
      } catch (error) {
        reportProgress(item, 'error', error.message ?? String(error))
        log.error('Got error deploying item %s: %o', item.groupKey, error)
        throw error
      }
    })
    return { errors: [], appliedChanges, extraProperties: { deploymentUrls } }
  } catch (error) {
    const deployErrors: DeployError[] = []
    if (error instanceof WalkError) {
      error.handlerErrors.forEach((nodeError: Error, key: PlanItemId) => {
        const item = deployPlan.getItem(key) as PlanItem
        if (nodeError instanceof NodeSkippedError) {
          reportProgress(item, 'cancelled', deployPlan.getItem(nodeError.causingNode).groupKey)
          deployErrors.push(new DeployError(item.groupKey, `Element ${key} was not deployed, as it depends on element ${nodeError.causingNode} which failed to deploy`))
        } else {
          deployErrors.push(new DeployError(item.groupKey, nodeError.message))
        }
      })
      if (error.circularDependencyError) {
        error.circularDependencyError.causingNodeIds.forEach((id: PlanItemId) => {
          const item = deployPlan.getItem(id) as PlanItem
          reportProgress(item, 'error', error.circularDependencyError.message)
          deployErrors.push(new DeployError(item.groupKey, error.circularDependencyError.message))
        })
      }
    }
    return { errors: deployErrors, appliedChanges, extraProperties: { deploymentUrls } }
  }
}
