// Copyright (C) 2018 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {produce} from 'immer';

import {assertExists} from '../base/logging';
import {Actions} from '../common/actions';
import {ConversionJobStatus} from '../common/conversion_jobs';
import {
  createEmptyNonSerializableState,
  createEmptyState,
} from '../common/empty_state';
import {State} from '../common/state';
import {STATE_VERSION} from '../common/state';
import {
  BUCKET_NAME,
  saveState,
  saveTrace,
  toSha256,
} from '../common/upload_utils';
import {globals as frontendGlobals} from '../frontend/globals';
import {publishConversionJobStatusUpdate} from '../frontend/publish';
import {Router} from '../frontend/router';

import {Controller} from './controller';
import {globals} from './globals';
import {RecordConfig, recordConfigValidator} from './record_config_types';
import {runValidator} from './validators';

export class PermalinkController extends Controller<'main'> {
  private lastRequestId?: string;
  constructor() {
    super('main');
  }

  run() {
    if (globals.state.permalink.requestId === undefined ||
        globals.state.permalink.requestId === this.lastRequestId) {
      return;
    }
    const requestId = assertExists(globals.state.permalink.requestId);
    this.lastRequestId = requestId;

    // if the |hash| is not set, this is a request to create a permalink.
    if (globals.state.permalink.hash === undefined) {
      const isRecordingConfig =
          assertExists(globals.state.permalink.isRecordingConfig);

      const jobName = 'create_permalink';
      publishConversionJobStatusUpdate({
        jobName,
        jobStatus: ConversionJobStatus.InProgress,
      });

      PermalinkController.createPermalink(isRecordingConfig)
          .then((hash) => {
            globals.dispatch(Actions.setPermalink({requestId, hash}));
          })
          .finally(() => {
            publishConversionJobStatusUpdate({
              jobName,
              jobStatus: ConversionJobStatus.NotRunning,
            });
          });
      return;
    }

    // Otherwise, this is a request to load the permalink.
    PermalinkController.loadState(globals.state.permalink.hash)
        .then((stateOrConfig) => {
          if (PermalinkController.isRecordConfig(stateOrConfig)) {
            // This permalink state only contains a RecordConfig. Show the
            // recording page with the config, but keep other state as-is.
            const validConfig =
                runValidator(recordConfigValidator, stateOrConfig as unknown)
                    .result;
            globals.dispatch(Actions.setRecordConfig({config: validConfig}));
            Router.navigate('#!/record');
            return;
          }
          globals.dispatch(Actions.setState({newState: stateOrConfig}));
          this.lastRequestId = stateOrConfig.permalink.requestId;
        });
  }

  private static upgradeState(state: State): State {
    if (state.version !== STATE_VERSION) {
      const newState = createEmptyState();
      let maxEngineId = Number.MIN_SAFE_INTEGER;
      // Copy the URL of the trace into the empty state.
      for (const cfg of Object.values(state.engines)) {
        newState
            .engines[cfg.id] = {id: cfg.id, ready: false, source: cfg.source};
        maxEngineId = Math.max(maxEngineId, Number(cfg.id));
      }
      if (maxEngineId !== Number.MIN_SAFE_INTEGER) {
        // set the current engine Id to the maximum engine Id in the permalink
        newState.currentEngineId = String(maxEngineId);
      }
      const message = `Unable to parse old state version. Discarding state ` +
          `and loading trace.`;
      console.warn(message);
      PermalinkController.updateStatus(message);
      return newState;
    } else {
      // Loaded state is presumed to be compatible with the State type
      // definition in the app. However, a non-serializable part has to be
      // recreated.
      state.nonSerializableState = createEmptyNonSerializableState();
    }
    return state;
  }

  private static isRecordConfig(stateOrConfig: State|
                                RecordConfig): stateOrConfig is RecordConfig {
    const mode = (stateOrConfig as {mode?: string}).mode;
    return mode !== undefined &&
        ['STOP_WHEN_FULL', 'RING_BUFFER', 'LONG_TRACE'].includes(mode);
  }

  private static async createPermalink(isRecordingConfig: boolean):
      Promise<string> {
    let uploadState: State|RecordConfig = globals.state;

    if (isRecordingConfig) {
      uploadState = globals.state.recordConfig;
    } else {
      const engine = assertExists(frontendGlobals.getCurrentEngine());
      let dataToUpload: File|ArrayBuffer|undefined = undefined;
      let traceName = `trace ${engine.id}`;
      if (engine.source.type === 'FILE') {
        dataToUpload = engine.source.file;
        traceName = dataToUpload.name;
      } else if (engine.source.type === 'ARRAY_BUFFER') {
        dataToUpload = engine.source.buffer;
      } else if (engine.source.type !== 'URL') {
        throw new Error(`Cannot share trace ${JSON.stringify(engine.source)}`);
      }

      if (dataToUpload !== undefined) {
        PermalinkController.updateStatus(`Uploading ${traceName}`);
        const url = await saveTrace(dataToUpload);
        // Convert state to use URLs and remove permalink.
        uploadState = produce(globals.state, (draft) => {
          draft.engines[engine.id].source = {type: 'URL', url};
          draft.permalink = {};
        });
      }
    }

    // Upload state.
    PermalinkController.updateStatus(`Creating permalink...`);
    const hash = await saveState(uploadState);
    PermalinkController.updateStatus(`Permalink ready`);
    return hash;
  }

  private static async loadState(id: string): Promise<State|RecordConfig> {
    const url = `https://storage.googleapis.com/${BUCKET_NAME}/${id}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
          `Could not fetch permalink.\n` +
          `Are you sure the id (${id}) is correct?\n` +
          `URL: ${url}`);
    }
    const text = await response.text();
    const stateHash = await toSha256(text);
    const state = JSON.parse(text);
    if (stateHash !== id) {
      throw new Error(`State hash does not match ${id} vs. ${stateHash}`);
    }
    if (!this.isRecordConfig(state)) {
      return this.upgradeState(state);
    }
    return state;
  }

  private static updateStatus(msg: string): void {
    // TODO(hjd): Unify loading updates.
    globals.dispatch(Actions.updateStatus({
      msg,
      timestamp: Date.now() / 1000,
    }));
  }
}
