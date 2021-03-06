import { ICave } from "../db/models/cave";

import { IRuntime } from ".";

import { Logger } from "../logger";
import { Game, Upload, Build } from "node-buse/lib/messages";

export type DownloadReason =
  | "install"
  | "reinstall"
  | "update"
  | "revert"
  | "heal";

export type InstallReason =
  | "install"
  | "reinstall"
  | "update"
  | "revert"
  | "heal";

export interface IQueueDownloadOpts {
  /** reason for starting this download */
  reason: DownloadReason;

  /**
   * game record at the time the download started - in case we're downloading
   * something that's not cached locally.
   */
  game: Game;

  /**
   * identifier of the cave this download was started for
   */
  caveId?: string;

  /** upload we're downloading */
  upload: Upload;

  /** build we're aiming for (if we're reverting/healing) */
  build?: Build;

  /** total size of download (size of archive or sum of patch sizes) */
  totalSize?: number;

  /** for fresh game installs, where to install it */
  installLocation?: string;

  /** for fresh game installs, where to install it */
  installFolder?: string;
}

export type TaskName = "install" | "uninstall" | "configure" | "launch";

export interface IQueueUninstallOpts {
  /** which cave we're uninstalling */
  caveId: string;
}

export interface IQueueLaunchOpts {
  /** which cave we're launching */
  caveId: string;
}

export interface IConfigureOpts {
  cave: ICave;
  game: Game;

  logger: Logger;

  runtime: IRuntime;
}
