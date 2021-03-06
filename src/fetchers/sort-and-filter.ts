import * as squel from "squel";
import { CaveModel, ICaveSummary } from "../db/models/cave";
import { DownloadKeyModel } from "../db/models/download-key";

import { itchPlatform } from "../os";
import { camelify } from "../format";

const platform = itchPlatform();
const platformProp = camelify("p_" + platform);

import { IStore, ITabParams, ICommonsState } from "../types";

import isPlatformCompatible from "../util/is-platform-compatible";

import { filter, sortBy as sortedBy } from "underscore";
import { Game } from "node-buse/lib/messages";
import { Space } from "../helpers/space";

function getCaveSummary(commons: ICommonsState, game: Game): ICaveSummary {
  const ids = commons.caveIdsByGameId[game.id];
  if (ids && ids.length > 0) {
    return commons.caves[ids[0]];
  }
  return null;
}

export interface ISortAndFilterOpts {
  disableFilters?: boolean;
}

export function sortAndFilter(
  games: Game[],
  tab: string,
  store: IStore,
  opts: ISortAndFilterOpts = {}
): Game[] {
  let set = games;
  const rs = store.getState();

  const sp = Space.fromState(rs, tab);
  const tabParams = sp.query() as ITabParams;
  const { sortBy, sortDirection = "DESC" } = tabParams;
  const prefs = rs.preferences;

  const hasFilters =
    prefs.onlyCompatibleGames ||
    prefs.onlyInstalledGames ||
    prefs.onlyOwnedGames;

  if (hasFilters && !opts.disableFilters) {
    const installedSet = rs.commons.caveIdsByGameId;
    const ownedSet = rs.commons.downloadKeyIdsByGameId;

    set = filter(set, g => {
      if (!g) {
        return false;
      }

      if (prefs.onlyCompatibleGames && !isPlatformCompatible(g)) {
        return false;
      }
      if (prefs.onlyInstalledGames && !installedSet[g.id]) {
        return false;
      }
      if (prefs.onlyOwnedGames && !ownedSet[g.id]) {
        return false;
      }

      return true;
    });
  }

  if (sortBy) {
    switch (sortBy) {
      case "title":
        set = sortedBy(set, "title");
        break;
      case "publishedAt":
        set = sortedBy(set, "publishedAt");
        break;
      case "lastTouchedAt":
        set = sortedBy(set, g => {
          const cave = getCaveSummary(rs.commons, g);
          if (cave) {
            return cave.lastTouchedAt;
          } else {
            return 0;
          }
        });
        break;
      case "secondsRun":
        set = sortedBy(set, g => {
          const cave = getCaveSummary(rs.commons, g);
          if (cave) {
            return cave.secondsRun;
          } else {
            return 0;
          }
        });
        break;
      case "installedSize":
        set = sortedBy(set, g => {
          const cave = getCaveSummary(rs.commons, g);
          if (cave) {
            return cave.installedSize;
          } else {
            return 0;
          }
        });
        break;
      default:
      // don't sort if we don't know how to
    }

    if (sortDirection === "DESC") {
      set.reverse();
    }

    set = filter(set, x => !!x);
  }

  return set;
}

export function addSortAndFilterToQuery(
  select: squel.Select,
  expr: squel.Expression,
  tab: string,
  store: IStore
): squel.Select {
  const rs = store.getState();
  const sp = Space.fromState(rs, tab);
  const tabParams = sp.query() as ITabParams;
  const { sortBy, sortDirection = "DESC" } = tabParams;
  const prefs = rs.preferences;

  if (prefs.onlyCompatibleGames) {
    expr.and(
      squel
        .expr()
        .or(platformProp)
        .or("type = ?", "html")
        .or("classification not in ?", ["game", "tool"])
    );
  }

  let joinCave = false;
  let joinDownloadKeys = false;

  if (prefs.onlyInstalledGames) {
    expr.and("caves.id is not null");
    joinCave = true;
  }

  if (prefs.onlyOwnedGames) {
    expr.and("downloadKeys.id is not null");
    joinDownloadKeys = true;
  }

  if (sortBy) {
    switch (sortBy) {
      case "title":
        // TODO: COLLATE NOCASE
        select.order("games.title", sortDirection === "ASC");
        break;
      case "publishedAt":
        select.order("games.publishedAt", sortDirection === "ASC");
        break;
      case "secondsRun":
        select.order("sum(caves.secondsRun)", sortDirection === "ASC");
        joinCave = true;
        break;
      case "lastTouchedAt":
        select.order("max(caves.lastTouchedAt)", sortDirection === "ASC");
        joinCave = true;
        break;
      case "installedSize":
        select.order("sum(caves.installedSize)", sortDirection === "ASC");
        joinCave = true;
        break;
      default:
      // dunno how to sort, don't do anything
    }
  } else {
    // see https://github.com/itchio/itch/issues/1352
    if (tab === "library") {
      select.order(
        "coalesce(caves.installedAt, downloadKeys.createdAt)",
        false /* DESC */
      );
      joinCave = true;
      joinDownloadKeys = true;
    }
  }

  if (joinCave) {
    select.left_join(CaveModel.table, null, "caves.gameId = games.id");
    // FIXME: should this be in if (joinCave) ?
    // does this break paging? so many questions.
    select.group("games.id");
  }

  if (joinDownloadKeys) {
    const meId = rs.session.credentials.me.id;
    select.left_join(
      DownloadKeyModel.table,
      null,
      squel.expr().and(
        "downloadKeys.id = ?",
        squel
          .select()
          .field("downloadKeys.id")
          .from("downloadKeys")
          .where(
            squel
              .expr()
              .and("downloadKeys.gameId = games.id")
              .and("downloadKeys.ownerId = ?", meId)
          )
          .limit(1)
      )
    );
  }

  select.where(expr);
  return select;
}
