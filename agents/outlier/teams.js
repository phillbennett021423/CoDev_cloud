// Team names and cities -> the abbreviations boards show ("Wizards" -> WAS), by
// league. A city two teams in a league share (New York, Los Angeles, Chicago in
// MLB) is left out there: the team name decides.
const LEAGUES = {
    nba: {
        ATL: ['hawks', 'atlanta'], BOS: ['celtics', 'boston'], BKN: ['nets', 'brooklyn'], CHA: ['hornets', 'charlotte'], CHI: ['bulls', 'chicago'],
        CLE: ['cavaliers', 'cavs', 'cleveland'], DAL: ['mavericks', 'mavs', 'dallas'], DEN: ['nuggets', 'denver'], DET: ['pistons', 'detroit'],
        GSW: ['warriors', 'golden state'], HOU: ['rockets', 'houston'], IND: ['pacers', 'indiana'], LAC: ['clippers'], LAL: ['lakers'],
        MEM: ['grizzlies', 'memphis'], MIA: ['heat', 'miami'], MIL: ['bucks', 'milwaukee'], MIN: ['timberwolves', 'wolves', 'minnesota'],
        NOP: ['pelicans', 'new orleans'], NYK: ['knicks', 'new york'], OKC: ['thunder', 'oklahoma city'], ORL: ['magic', 'orlando'],
        PHI: ['76ers', 'sixers', 'philadelphia'], PHX: ['suns', 'phoenix'], POR: ['trail blazers', 'blazers', 'portland'], SAC: ['kings', 'sacramento'],
        SAS: ['spurs', 'san antonio'], TOR: ['raptors', 'toronto'], UTA: ['jazz', 'utah'], WAS: ['wizards', 'washington']
    },
    wnba: {
        ATL: ['dream', 'atlanta'], CHI: ['sky', 'chicago'], CON: ['sun', 'connecticut'], DAL: ['wings', 'dallas'], GSV: ['valkyries', 'golden state'],
        IND: ['fever', 'indiana'], LV: ['aces', 'las vegas'], LA: ['sparks', 'los angeles'], MIN: ['lynx', 'minnesota'], NY: ['liberty', 'new york'],
        PHX: ['mercury', 'phoenix'], POR: ['fire', 'portland'], SEA: ['storm', 'seattle'], TOR: ['tempo', 'toronto'], WAS: ['mystics', 'washington']
    },
    nfl: {
        ARI: ['cardinals', 'arizona'], ATL: ['falcons', 'atlanta'], BAL: ['ravens', 'baltimore'], BUF: ['bills', 'buffalo'], CAR: ['panthers', 'carolina'],
        CHI: ['bears', 'chicago'], CIN: ['bengals', 'cincinnati'], CLE: ['browns', 'cleveland'], DAL: ['cowboys', 'dallas'], DEN: ['broncos', 'denver'],
        DET: ['lions', 'detroit'], GB: ['packers', 'green bay'], HOU: ['texans', 'houston'], IND: ['colts', 'indianapolis'], JAX: ['jaguars', 'jags', 'jacksonville'],
        KC: ['chiefs', 'kansas city'], LV: ['raiders', 'las vegas'], LAC: ['chargers'], LAR: ['rams'], MIA: ['dolphins', 'miami'], MIN: ['vikings', 'minnesota'],
        NE: ['patriots', 'pats', 'new england'], NO: ['saints', 'new orleans'], NYG: ['giants'], NYJ: ['jets'], PHI: ['eagles', 'philadelphia'],
        PIT: ['steelers', 'pittsburgh'], SF: ['49ers', 'niners', 'san francisco'], SEA: ['seahawks', 'seattle'], TB: ['buccaneers', 'bucs', 'tampa bay'],
        TEN: ['titans', 'tennessee'], WAS: ['commanders', 'washington']
    },
    mlb: {
        ARI: ['diamondbacks', 'dbacks', 'arizona'], ATH: ['athletics'], ATL: ['braves', 'atlanta'], BAL: ['orioles', 'baltimore'], BOS: ['red sox', 'boston'],
        CHC: ['cubs'], CWS: ['white sox'], CIN: ['reds', 'cincinnati'], CLE: ['guardians', 'cleveland'], COL: ['rockies', 'colorado'], DET: ['tigers', 'detroit'],
        HOU: ['astros', 'houston'], KC: ['royals', 'kansas city'], LAA: ['angels'], LAD: ['dodgers'], MIA: ['marlins', 'miami'], MIL: ['brewers', 'milwaukee'],
        MIN: ['twins', 'minnesota'], NYM: ['mets'], NYY: ['yankees'], PHI: ['phillies', 'philadelphia'], PIT: ['pirates', 'pittsburgh'], SD: ['padres', 'san diego'],
        SF: ['giants', 'san francisco'], SEA: ['mariners', 'seattle'], STL: ['cardinals', 'st louis'], TB: ['rays', 'tampa bay'], TEX: ['rangers', 'texas'],
        TOR: ['blue jays', 'jays', 'toronto'], WSH: ['nationals', 'nats', 'washington']
    },
    nhl: {
        ANA: ['ducks', 'anaheim'], BOS: ['bruins', 'boston'], BUF: ['sabres', 'buffalo'], CGY: ['flames', 'calgary'], CAR: ['hurricanes', 'canes', 'carolina'],
        CHI: ['blackhawks', 'chicago'], COL: ['avalanche', 'avs', 'colorado'], CBJ: ['blue jackets', 'columbus'], DAL: ['stars', 'dallas'], DET: ['red wings', 'detroit'],
        EDM: ['oilers', 'edmonton'], FLA: ['panthers', 'florida'], LAK: ['kings', 'los angeles'], MIN: ['wild', 'minnesota'], MTL: ['canadiens', 'habs', 'montreal'],
        NSH: ['predators', 'preds', 'nashville'], NJD: ['devils', 'new jersey'], NYI: ['islanders'], NYR: ['rangers'], OTT: ['senators', 'sens', 'ottawa'],
        PHI: ['flyers', 'philadelphia'], PIT: ['penguins', 'pens', 'pittsburgh'], SJS: ['sharks', 'san jose'], SEA: ['kraken', 'seattle'], STL: ['blues', 'st louis'],
        TBL: ['lightning', 'tampa bay'], TOR: ['maple leafs', 'leafs', 'toronto'], UTA: ['mammoth', 'utah'], VAN: ['canucks', 'vancouver'],
        VGK: ['golden knights', 'vegas'], WSH: ['capitals', 'caps', 'washington'], WPG: ['jets', 'winnipeg']
    }
};

// Other abbreviations boards use for the same teams.
const ALSO = {
    nba: { BKN: ['BRK'], CHA: ['CHO'], GSW: ['GS'], NOP: ['NO'], NYK: ['NY'], PHX: ['PHO'], SAS: ['SA'], UTA: ['UTAH'], WAS: ['WSH'] },
    wnba: { CON: ['CONN'], GSV: ['GS'], LV: ['LVA'], LA: ['LAS'], NY: ['NYL'], PHX: ['PHO'], WAS: ['WSH'] },
    nfl: { GB: ['GNB'], JAX: ['JAC'], KC: ['KAN'], LV: ['LVR'], LAR: ['LA'], NE: ['NWE'], NO: ['NOR'], SF: ['SFO'], TB: ['TAM'], WAS: ['WSH'] },
    mlb: { ARI: ['AZ'], ATH: ['OAK'], CWS: ['CHW'], KC: ['KCR'], SD: ['SDP'], SF: ['SFG'], TB: ['TBR'], WSH: ['WAS'] },
    nhl: { LAK: ['LA'], NJD: ['NJ'], SJS: ['SJ'], TBL: ['TB'], VGK: ['VEG'], UTA: ['UTAH'], WSH: ['WAS'] }
};

const LEAGUE_OF = { nba: 'nba', basketball: 'nba', wnba: 'wnba', nfl: 'nfl', football: 'nfl', mlb: 'mlb', baseball: 'mlb', nhl: 'nhl', hockey: 'nhl' };

function namedIn(text, league) {
    const lower = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    // Abbreviations only in capitals, so "was" or "min" in a sentence isn't a team.
    const caps = ` ${String(text || '').replace(/[^A-Za-z0-9]+/g, ' ')} `;
    return Object.entries(LEAGUES[league])
        .filter(([abbr, names]) => names.some(n => lower.includes(` ${n} `)) || [abbr, ...((ALSO[league] || {})[abbr] || [])].some(a => caps.includes(` ${a} `)))
        .map(([abbr]) => abbr);
}

// The teams text names: { league, teams } in the sport's league when it's one of
// these, else the first league (NBA, WNBA, NFL, MLB, NHL) where two teams are named.
function teamsNamed(text, sport) {
    const own = LEAGUE_OF[String(sport || '').toLowerCase().replace(/[^a-z]/g, '')];
    if (own) return { league: own, teams: namedIn(text, own) };
    let best = { league: null, teams: [] };
    for (const league of Object.keys(LEAGUES)) {
        const teams = namedIn(text, league);
        if (teams.length >= 2) return { league, teams };
        if (teams.length > best.teams.length) best = { league, teams };
    }
    return best;
}

// Everything a board might call that team: its abbreviations, name and city.
const teamTokens = (abbr, league) => [abbr, ...((ALSO[league] || {})[abbr] || []), ...((LEAGUES[league] || {})[abbr] || [])];

module.exports = { LEAGUES, teamsNamed, teamTokens };
