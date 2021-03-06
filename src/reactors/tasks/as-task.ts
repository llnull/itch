import uuid from "../../util/uuid";
import { throttle } from "underscore";
import * as memory from "memory-streams";

import {
  IStore,
  IProgressInfo,
  isCancelled,
  TaskName,
  isAborted,
} from "../../types";
import { DB } from "../../db";
import Context from "../../context";
import { actions } from "../../actions";

import rootLogger, { Logger, makeLogger } from "../../logger";
import { getCurrentTasks } from "./as-task-persistent-state";

interface IAsTaskOpts {
  store: IStore;
  db: DB;
  name: TaskName;
  gameId: number;

  /** Where the task actually performs its duty */
  work: (ctx: Context, logger: Logger) => Promise<void>;

  /** Called with the thrown error & the logs so far if set */
  onError?: (error: Error, log: string) => Promise<void>;
}

export default async function asTask(opts: IAsTaskOpts) {
  const id = uuid();

  const { store, db, name, gameId } = opts;

  const memlog = new memory.WritableStream();
  const logger = makeLogger({ customOut: memlog });

  store.dispatch(
    actions.taskStarted({
      id,
      name,
      gameId,
      startedAt: Date.now(),
    })
  );

  const ctx = new Context(store, db);
  ctx.registerTaskId(id);
  ctx.on(
    "progress",
    throttle((ev: IProgressInfo) => {
      store.dispatch(actions.taskProgress({ id, ...ev }));
    }, 250)
  );

  getCurrentTasks()[id] = ctx;

  let err: Error;

  const { work, onError } = opts;

  try {
    await work(ctx, logger);
  } catch (e) {
    err = e;
  }

  delete getCurrentTasks()[id];
  try {
    logger.close();
  } catch (e) {
    rootLogger.warn(`Couldn't close logger: ${e.stack}`);
  }

  if (err) {
    if (isCancelled(err)) {
      rootLogger.warn(`Task ${name} cancelled`);
    } else if (isAborted(err)) {
      rootLogger.warn(`Task ${name} aborted`);
    } else {
      rootLogger.warn(`Task ${name} threw: ${err.stack}`);
      if (onError) {
        await onError(err, memlog ? memlog.toString() : "(No log)");
      }
    }
  }

  store.dispatch(
    actions.taskEnded({
      id,
      err: err ? `${err}` : null,
    })
  );
}
