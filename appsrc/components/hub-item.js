
import React, {Component, PropTypes} from 'react'
import {createStructuredSelector} from 'reselect'

import {connect} from './connect'

class MainAction extends Component {
  render () {
    return <span>main action</span>
  }
}

class SecondaryAction extends Component {
  render () {
    return <span>secondary action</span>
  }
}

export class HubItem extends Component {
  render () {
    const {game, cavesByGameId} = this.props
    const cave = cavesByGameId[game.id]
    const {title, coverUrl} = game

    const platformCompatible = true
    const mayDownload = true
    const actionProps = {cave, game, platformCompatible, mayDownload}

    return <div className='hub-item'>
      <section className='cover' style={{backgroundImage: `url("${coverUrl}")`}}/>

      <section className='undercover'>
        <section className='title'>
          {title}
        </section>

        <section className='actions'>
          <MainAction {...actionProps}/>
          <SecondaryAction {...actionProps}/>
        </section>
      </section>
    </div>
  }

  fakeActions () {
    return <section className='actions'>
      <div className='button'>
        <span className='icon icon-checkmark'/>
        <span>Launch</span>
      </div>
      <div className='icon-button'>
      </div>
    </section>
  }
}

HubItem.propTypes = {
  game: PropTypes.shape({
    title: PropTypes.string,
    coverUrl: PropTypes.string
  }),
  cavesByGameId: PropTypes.object
}

const mapStateToProps = createStructuredSelector({
  cavesByGameId: (state) => state.globalMarket.cavesByGameId
})

export default connect(
  mapStateToProps
)(HubItem)
