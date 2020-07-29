/*
 * Copyright (C) 2020 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <limits>

#include <stdint.h>

#include "src/trace_processor/importers/common/flow_tracker.h"
#include "src/trace_processor/importers/common/slice_tracker.h"
#include "src/trace_processor/storage/trace_storage.h"
#include "src/trace_processor/types/trace_processor_context.h"

namespace perfetto {
namespace trace_processor {

FlowTracker::FlowTracker(TraceProcessorContext* context) : context_(context) {}

FlowTracker::~FlowTracker() = default;

/* TODO: if we report a flow event earlier that a corresponding slice then
  flow event would not be added, and it will increase "flow_no_enclosing_slice"
  In catapult, it was possible to report a flow after an enclosing slice if
  timestamps were equal. But because of our seqential processing of a trace
  it is a bit tricky to make it here.
  We suspect that this case is too rare or impossible */
void FlowTracker::Begin(TrackId track_id, FlowId flow_id) {
  base::Optional<SliceId> open_slice_id =
      context_->slice_tracker->GetTopmostSliceOnTrack(track_id);
  if (!open_slice_id) {
    context_->storage->IncrementStats(stats::flow_no_enclosing_slice);
    return;
  }
  if (flow_to_slice_map_.count(flow_id) != 0) {
    context_->storage->IncrementStats(stats::flow_duplicate_id);
    return;
  }
  flow_to_slice_map_[flow_id] = open_slice_id.value();
}

void FlowTracker::Step(TrackId track_id, FlowId flow_id) {
  base::Optional<SliceId> open_slice_id =
      context_->slice_tracker->GetTopmostSliceOnTrack(track_id);
  if (!open_slice_id) {
    context_->storage->IncrementStats(stats::flow_no_enclosing_slice);
    return;
  }
  if (flow_to_slice_map_.count(flow_id) == 0) {
    context_->storage->IncrementStats(stats::flow_step_without_start);
    return;
  }
  SliceId slice_out_id = flow_to_slice_map_[flow_id];
  InsertFlow(slice_out_id, open_slice_id.value());
  flow_to_slice_map_[flow_id] = open_slice_id.value();
}

void FlowTracker::End(TrackId track_id,
                      FlowId flow_id,
                      bool bind_enclosing_slice) {
  if (!bind_enclosing_slice) {
    pending_flow_ids_map_[track_id].push_back(flow_id);
    return;
  }
  base::Optional<SliceId> open_slice_id =
      context_->slice_tracker->GetTopmostSliceOnTrack(track_id);
  if (!open_slice_id) {
    context_->storage->IncrementStats(stats::flow_no_enclosing_slice);
    return;
  }
  if (flow_to_slice_map_.count(flow_id) == 0) {
    context_->storage->IncrementStats(stats::flow_end_without_start);
    return;
  }
  SliceId slice_out_id = flow_to_slice_map_[flow_id];
  InsertFlow(slice_out_id, open_slice_id.value());
  // TODO(andrewbb): Don't erase the flow_id if we're a version 2 event.
  flow_to_slice_map_.erase(flow_id);
}

FlowId FlowTracker::GetFlowIdForV1Event(uint64_t source_id,
                                        StringId cat,
                                        StringId name) {
  V1FlowId v1_flow_id = {source_id, cat, name};
  auto iter = v1_flow_id_to_flow_id_map_.find(v1_flow_id);
  if (iter != v1_flow_id_to_flow_id_map_.end()) {
    return iter->second;
  }
  return v1_flow_id_to_flow_id_map_[v1_flow_id] = v1_id_counter_++;
}

void FlowTracker::ClosePendingEventsOnTrack(TrackId track_id,
                                            SliceId slice_id) {
  auto iter = pending_flow_ids_map_.find(track_id);
  if (iter == pending_flow_ids_map_.end())
    return;

  for (FlowId flow_id : iter->second) {
    SliceId slice_out_id = flow_to_slice_map_[flow_id];
    InsertFlow(slice_out_id, slice_id);
  }

  pending_flow_ids_map_.erase(iter);
}

void FlowTracker::InsertFlow(SliceId slice_out_id, SliceId slice_in_id) {
  tables::FlowTable::Row row(slice_out_id, slice_in_id);
  context_->storage->mutable_flow_table()->Insert(row);
}

}  // namespace trace_processor
}  // namespace perfetto
