import * as React from "react";
import { connect, Dispatchers, actionCreatorsList } from "./connect";

import { IMeatProps } from "./meats/types";

import Games from "./games";

import { Space } from "../helpers/space";

import styled, * as styles from "./styles";

import Link from "./basics/link";
import LocationTitleBarExtra from "./location-title-bar-extra";
import FiltersContainer from "./filters-container";
import { showInExplorerString } from "../format/show-in-explorer";
import { GameColumn } from "./game-table/table";
import format from "./format";

const columns = [
  GameColumn.Cover,
  GameColumn.Title,
  GameColumn.LastPlayed,
  GameColumn.PlayTime,
  GameColumn.InstalledSize,
];

const LocationContainer = styled.div`
  ${styles.meat()};
`;

export class Location extends React.PureComponent<IProps & IDerivedProps> {
  render() {
    const { tab, tabInstance, browseInstallLocation, loading } = this.props;

    const locationName = Space.fromInstance(tabInstance).firstPathElement();

    return (
      <LocationContainer>
        <FiltersContainer loading={loading}>
          <LocationTitleBarExtra tabInstance={tabInstance} />
          <Link
            label={format(showInExplorerString())}
            onClick={e => browseInstallLocation({ name: locationName })}
          />
        </FiltersContainer>

        <Games tab={tab} forcedLayout="table" columns={columns} />
      </LocationContainer>
    );
  }
}

interface IProps extends IMeatProps {}

const actionCreators = actionCreatorsList("browseInstallLocation");

type IDerivedProps = Dispatchers<typeof actionCreators>;

export default connect<IProps>(Location, { actionCreators });
