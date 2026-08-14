import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";
import { getDataFilePath, readAppState } from "../../shared/data.js";
import {
  claimOmpLease,
  newOwnerToken,
  patchMarkerIfOwner,
  readMarkerOutcome,
  removeMarkerIfOwner,
} from "../../shared/marker.js";
import type { LeaseStore } from "./lease.js";
import { RemarcWakeRuntime, type WakeRuntimeDependencies } from "./runtime.js";

export const leaseStore: LeaseStore = {
  read: readMarkerOutcome,
  async claim(request, options) {
    const outcome = await claimOmpLease(
      request.markerId,
      request.remarcSessionId,
      request.ownerToken,
      {
        dataFilePath: request.dataFilePath,
        transcriptPath: request.transcriptPath,
        ownerPid: request.ownerPid,
        leaseHeartbeatAt: new Date(request.now).toISOString(),
        ...(request.resetDeliveryState
          ? {
              pendingWake: null,
              extra: { wakedAt: {}, deliveredIds: [] },
            }
          : {}),
      },
      options
    );
    if (outcome.kind === "conflict") {
      return {
        kind: "conflict" as const,
        ownerId: outcome.ownerMarkerId,
        marker: outcome.marker,
      };
    }
    if (outcome.kind === "invalid" || outcome.kind === "unsafe") {
      return { kind: outcome.kind, reason: outcome.reason };
    }
    return outcome;
  },
  patch: patchMarkerIfOwner,
  remove: removeMarkerIfOwner,
};

export const dependencies: WakeRuntimeDependencies = {
  leaseStore,
  readAppState,
  getDataFilePath,
  newOwnerToken,
  ownerPid: process.pid,
  now: Date.now,
  watchDataFile(path, onChange, onError) {
    const target = basename(path);
    const watcher = watch(dirname(path), { persistent: false }, (_event, changed) => {
      if (changed == null || changed.toString() === target) onChange();
    });
    watcher.on("error", onError);
    return watcher;
  },
};

const extension: ExtensionFactory = (api) => {
  new RemarcWakeRuntime(api, dependencies).register();
};

export default extension;
