
import {difference} from "underscore";
import * as bluebird from "bluebird";

import sf from "../os/sf";
import noop from "./noop";
import butler from "./butler";
import {Logger} from "../logger";

import * as ospath from "path";

import {IProgressListener} from "../types";
import {ICaveRecord} from "../types";

import {EventEmitter} from "events";

// FIXME: all this can and should be done with a butler command instead.
// Using a staging folder is overkill and slows down the install process!
// Using a .json file as the receipt format is slow (can't be streamed, etc.)

interface ISingleResult {
  deployed?: boolean;
}

interface IDeployResult {
  status: string;
}

interface ISingleListener {
  (onlyFile: string): Promise<ISingleResult>;
}

export interface IDeployOpts {
  stagePath: string;
  destPath: string;
  cave?: ICaveRecord;
  onProgress: IProgressListener;
  onSingle?: ISingleListener;
  logger?: Logger;
}

let singlenoop: ISingleListener = async (onlyFile: string) => {
  return {};
};

let self = {
  /**
   * Given a stagePath, and a destPath
   *   - Figures out which files disappeared from stage since last deploying to dest
   *   - Removes those
   *   - Copy all the new files from stage to dest, overwriting
   *   - Write receipt with list of files present in stage at deploy time
   *     (that receipt will be used on next deploy)
   */
  deploy: async function (opts: IDeployOpts): Promise<IDeployResult> {
    const {stagePath, destPath, onProgress = noop, onSingle = singlenoop, logger} = opts;

    const stageFiles = await sf.glob("**", {
      cwd: stagePath,
      dot: true,
      nodir: true,
      ignore: sf.globIgnore,
    });

    if (stageFiles.length === 1) {
      let onlyFile = ospath.join(stagePath, stageFiles[0]);
      let res = await onSingle(onlyFile);
      if (res && res.deployed) {
        // onSingle returning true means it's been handled upstraem
        return {status: "ok"};
      }
    }

    await butler.mkdir(destPath);

    logger.info(`cleaning up dest path ${destPath}`);

    const receiptPath = ospath.join(destPath, ".itch", "receipt.json");
    let destFiles = [] as string[];

    try {
      let receiptContents = await sf.readFile(receiptPath, {encoding: "utf8"});
      let receipt = JSON.parse(receiptContents);
      destFiles = receipt.files || [];
      logger.info(`Got receipt for an existing ${destFiles.length}-files install.`);
    } catch (err) {
      logger.warn(`Could not read receipt: ${err.message}`);
    }
    if (!destFiles.length) {
      logger.info("Globbing for destfiles");
      destFiles = await sf.glob("**", {cwd: destPath, dot: true, nodir: true, ignore: sf.globIgnore});
    }

    logger.info(`dest has ${destFiles.length} potential dinosaurs`);

    const dinosaurs = difference(destFiles, stageFiles);
    if (dinosaurs.length) {
      logger.info(`removing ${dinosaurs.length} dinosaurs in dest`);
      logger.info(`example dinosaurs: ${JSON.stringify(dinosaurs.slice(0, 10), null, 2)}`);

      await bluebird.map(dinosaurs, (rel) => {
        let dinosaur = ospath.join(destPath, rel);
        return butler.wipe(dinosaur);
      }, {concurrency: 4});
    } else {
      logger.info("no dinosaurs");
    }

    logger.info("merging stage with dest");
    await butler.ditto(stagePath, destPath, {
      emitter: new EventEmitter(),
      onProgress,
    });

    logger.info("everything copied, writing receipt");
    let cave = opts.cave || {};

    const receiptObject = { cave, files: stageFiles };
    const receiptJson = JSON.stringify(receiptObject, null, 2);
    await sf.writeFile(receiptPath, receiptJson, {encoding: "utf8"});

    return {status: "ok"};
  },
};

export default self;