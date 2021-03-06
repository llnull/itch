import * as React from "react";

import { ModalWidgetDiv } from "./modal-widget";

import { ICave } from "../../db/models/cave";
import { fromDateTimeField, toDateTimeField } from "../../db/datetime-field";

import { actions } from "../../actions";

import format from "../format";

import Icon from "../basics/icon";
import CustomDate from "../basics/custom-date";

import styled from "../styles";
import { lighten } from "polished";
import { MONTH_YEAR_FORMAT, DAY_MONTH_FORMAT } from "../../format/index";
import { connect, Dispatchers, actionCreatorsList } from "../connect";
import { Game, Build } from "node-buse/lib/messages";
import { IModalWidgetProps } from "./index";

const BuildListDiv = styled.div`
  width: 100%;
  max-height: 400px;

  padding-right: 15px;

  overflow-y: scroll;

  .builds--month {
    width: 100%;
    border-left: 2px solid ${props => props.theme.accent};
    margin-top: 24px;
    padding-left: 12px;
    padding-top: 8px;
    padding-bottom: 8px;
    font-size: ${props => props.theme.fontSizes.larger};
    font-weight: bold;
  }

  .builds--item {
    display: flex;
    flex-direction: row;

    width: 100%;
    margin: 8px 0;
    background: ${props => props.theme.sidebarBackground};
    padding: 12px 16px;
    align-items: center;

    &:hover {
      cursor: pointer;
      background: ${props => lighten(0.05, props.theme.sidebarBackground)};
    }

    .item--version {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .filler {
      flex-grow: 1;
    }

    .spacer {
      flex-shrink: 0;
      width: 16px;
    }
  }

  .version--user {
    font-weight: bold;
    font-size: ${props => props.theme.fontSizes.large};
    margin-right: 16px;
  }

  .version--raw,
  .version--timeago {
    color: ${props => props.theme.secondaryText};
  }
`;

function monthFor(b: Build) {
  const date = fromDateTimeField(b.updatedAt);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

class RevertCave extends React.PureComponent<IProps & IDerivedProps> {
  render() {
    const { remoteBuilds } = this.props.modal.widgetParams;

    const builds: JSX.Element[] = [];
    let lastMonth = 0;
    for (const build of remoteBuilds) {
      const month = monthFor(build);
      if (month != lastMonth) {
        const monthDate = fromDateTimeField(build.updatedAt);
        builds.push(
          <div key={`month-${month}`} className="builds--month">
            <CustomDate date={monthDate} format={MONTH_YEAR_FORMAT} />
          </div>
        );
        lastMonth = month;
      }
      builds.push(this.renderBuild(build));
    }

    return (
      <ModalWidgetDiv>
        <BuildListDiv>{builds}</BuildListDiv>
      </ModalWidgetDiv>
    );
  }

  renderBuild(b: Build): JSX.Element {
    const version = b.userVersion || b.version;
    const updatedAt = fromDateTimeField(b.updatedAt);

    return (
      <div
        className="builds--item"
        key={b.id}
        data-build-id={b.id}
        onClick={this.onClick}
      >
        <Icon icon="history" />
        <div className="spacer" />
        {version ? (
          <div className="version--user">
            {format(["prompt.revert.version", { version }])}
          </div>
        ) : null}
        <div className="version--raw">{`#${b.id}`}</div>
        <div className="filler" />
        <div className="spacer" />
        <div
          className="timeago"
          data-rh={JSON.stringify({ date: toDateTimeField(updatedAt) })}
        >
          <CustomDate date={updatedAt} format={DAY_MONTH_FORMAT} />
        </div>
      </div>
    );
  }

  onClick = (ev: React.MouseEvent<HTMLDivElement>) => {
    const revertBuildId = parseInt(ev.currentTarget.dataset.buildId, 10);

    this.props.closeModal({
      action: actions.modalResponse({
        revertBuildId,
      }),
    });
  };
}

export interface IRevertCaveParams {
  currentCave: ICave;
  game: Game;
  remoteBuilds: Build[];
}

export interface IRevertCaveResponse {
  /** which build id to revert to */
  revertBuildId?: number;
}

interface IProps
  extends IModalWidgetProps<IRevertCaveParams, IRevertCaveResponse> {}

const actionCreators = actionCreatorsList("closeModal");

type IDerivedProps = Dispatchers<typeof actionCreators>;

export default connect<IProps>(RevertCave, { actionCreators });
