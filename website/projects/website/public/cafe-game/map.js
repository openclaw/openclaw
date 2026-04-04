/**
 * Thinker's Cafe - Tile Map Data
 * 15 wide x 11 tall, 32px tiles
 * Pokemon-style top-down cafe interior
 *
 * Coordinate system: (0,0) = top-left
 * Index = y * 15 + x
 */
window.CafeMap = {
  width: 15,
  height: 11,
  tileSize: 32,

  // ─── Layer 0: Floor ───────────────────────────────────────────
  // 0 = wood floor, 1 = dark wood, 2 = carpet, 3 = counter floor
  //
  // Row 0: top wall (no floor visible)
  // Row 1: behind counter area (dark wood)
  // Row 2-3: counter zone (counter floor behind, dark wood)
  // Row 4: gap row (wood floor)
  // Row 5-9: seating area (carpet center, wood edges)
  // Row 10: bottom row (wood floor)
  floor: [
    // Row 0  - top wall row
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    // Row 1  - window / clock row
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    // Row 2  - counter top
    0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0,
    // Row 3  - counter front / Cruz behind
    0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0,
    // Row 4  - open floor between counter and seats
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // Row 5  - seat row 1 (polaris, sirius, mira)
    0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0,
    // Row 6  - seat row 2 (nova, rigel, empty1)
    0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0,
    // Row 7  - seat row 3 (empty2, empty3, last seat)
    0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0,
    // Row 8  - open floor
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    // Row 9  - bottom feature row (news wall, war room, cat)
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    // Row 10 - bottom wall
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  ],

  // ─── Layer 1: Walls & Furniture ───────────────────────────────
  // 0  = empty (walkable)
  // 10 = wall, 11 = window, 12 = counter, 13 = shelf/bookshelf
  // 14 = chair, 15 = table, 16 = door (entrance)
  // 17 = news_wall, 18 = war_room_door, 19 = cat_window
  // 20 = coffee_machine, 21 = clock, 22 = open_sign
  // 23 = coat_rack, 24 = cruz_npc
  walls: [
    // Row 0  - top perimeter wall with windows; Starry Night at col 11-12
    10, 11, 11, 11, 11, 11, 10, 10, 10, 10, 10, 27, 28, 21, 10,
    // Row 1  - bar back shelves (bottles & glasses behind counter); vinyl player at col 10
    10, 26, 26, 26, 26, 26, 26, 26, 26, 26, 32,  0, 13, 23, 10,
    // Row 2  - counter row (Cruz behind, coffee machine); kintsugi cup at col 5
    10,  0, 12, 12, 24, 31, 12, 20, 12, 12, 12,  0, 13,  0, 10,
    // Row 3  - counter front panel (vertical face towards customers)
    10,  0, 25, 25, 25, 25, 25, 25, 25, 25, 25,  0,  0, 22, 10,
    // Row 4  - open walkway; The Kiss top at col 11
    10,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, 29,  0,  0, 10,
    // Row 5  - seat row 1: polaris(3,5) sirius(6,5) mira(9,5); The Kiss bottom at col 11
    10,  0, 15, 14,  0, 15, 14,  0, 15, 14,  0, 30,  0,  0, 10,
    // Row 6  - seat row 2: nova(3,6) rigel(6,6) empty1(9,6)
    10,  0, 15, 14,  0, 15, 14,  0, 15, 14,  0,  0,  0,  0, 10,
    // Row 7  - seat row 3: empty2(3,7) empty3(6,7) last_seat(9,7)
    10,  0, 15, 14,  0, 15, 14,  0, 15, 14,  0,  0,  0,  0, 10,
    // Row 8  - open walkway
    10,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0, 10,
    // Row 9  - bottom feature row
    10, 17, 17, 17, 17,  0, 18, 18,  0,  0,  0,  0, 19, 19, 10,
    // Row 10 - bottom perimeter wall with entrance door
    10, 10, 10, 10, 10, 10, 10, 16, 10, 10, 10, 10, 10, 10, 10,
  ],

  // ─── Layer 2: Collision ───────────────────────────────────────
  // 0 = walkable, 1 = blocked
  collision: [
    // Row 0  - all wall = blocked
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    // Row 1  - bar back shelves blocked, bookshelf blocked, coat rack walkable
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1,
    // Row 2  - counter row all blocked (player can't go behind counter)
    1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1,
    // Row 3  - counter front edge blocked, right corridor open (OPEN sign on wall)
    1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1,
    // Row 4  - open walkway; The Kiss top blocks col 11
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1,
    // Row 5  - tables blocked, chairs blocked, gaps walkable; The Kiss bottom blocks col 11
    1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1,
    // Row 6  - tables blocked, chairs blocked, gaps walkable
    1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1,
    // Row 7  - tables blocked, chairs blocked, gaps walkable
    1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1,
    // Row 8  - open walkway
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    // Row 9  - news wall blocked, walkable path through center, cat window blocked
    1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1,
    // Row 10 - all wall blocked except entrance door
    1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1,
  ],

  // ─── Layer 3: Interaction Points ──────────────────────────────
  interactions: [
    // Cruz behind counter - talk from above (behind bar)
    { tileX: 4, tileY: 2, type: 'npc', id: 'cruz', facingRequired: 'up' },
    // Counter front — talk to Cruz from customer side (row 4 facing up → row 3)
    { tileX: 3, tileY: 3, type: 'npc', id: 'cruz' },
    { tileX: 4, tileY: 3, type: 'npc', id: 'cruz' },
    { tileX: 5, tileY: 3, type: 'npc', id: 'cruz' },
    { tileX: 6, tileY: 3, type: 'npc', id: 'cruz' },
    // Coffee machine - interact from above
    { tileX: 7, tileY: 2, type: 'object', id: 'coffeeMachine', facingRequired: 'up' },
    // Counter front — coffee machine from customer side
    { tileX: 7, tileY: 3, type: 'object', id: 'coffeeMachine' },
    { tileX: 8, tileY: 3, type: 'object', id: 'coffeeMachine' },
    // Bookshelf = The Grimoire (Prompt Library) — interact from left or below
    { tileX: 12, tileY: 1, type: 'grimoire', id: 'grimoire' },
    { tileX: 12, tileY: 2, type: 'grimoire', id: 'grimoire' },
    // Clock - look up at it
    { tileX: 13, tileY: 0, type: 'object', id: 'clock', facingRequired: 'up' },
    // OPEN sign - interact from left
    { tileX: 13, tileY: 3, type: 'object', id: 'openSign', facingRequired: 'right' },
    // Seat row 1: polaris, sirius, mira
    { tileX: 3, tileY: 5, type: 'npc', id: 'polaris', facingRequired: 'left' },
    { tileX: 6, tileY: 5, type: 'npc', id: 'sirius', facingRequired: 'left' },
    { tileX: 9, tileY: 5, type: 'npc', id: 'mira', facingRequired: 'left' },
    // Seat row 2: nova, rigel, empty1
    { tileX: 3, tileY: 6, type: 'npc', id: 'nova', facingRequired: 'left' },
    { tileX: 6, tileY: 6, type: 'npc', id: 'rigel', facingRequired: 'left' },
    { tileX: 9, tileY: 6, type: 'npc', id: 'empty1', facingRequired: null },
    // Seat row 3: empty2, empty3, last seat
    { tileX: 3, tileY: 7, type: 'npc', id: 'empty2', facingRequired: null },
    { tileX: 6, tileY: 7, type: 'npc', id: 'empty3', facingRequired: null },
    { tileX: 9, tileY: 7, type: 'npc', id: 'lastSeat', facingRequired: null },
    // News wall
    { tileX: 2, tileY: 9, type: 'object', id: 'newsWall', facingRequired: 'down' },
    // Note board — read all visitor notes
    { tileX: 1, tileY: 4, type: 'object', id: 'noteBoard', facingRequired: 'left' },
    // War room door
    { tileX: 6, tileY: 9, type: 'object', id: 'warRoomDoor', facingRequired: 'down' },
    // Cat on windowsill
    { tileX: 12, tileY: 9, type: 'npc', id: 'cat', facingRequired: 'down' },
    // Starry Night painting (approach from below, row 1 looking up)
    { tileX: 11, tileY: 1, type: 'object', id: 'starryNight', facingRequired: 'up' },
    { tileX: 12, tileY: 1, type: 'object', id: 'starryNight', facingRequired: 'up' },
    // The Kiss painting (approach from right, col 12 looking left)
    { tileX: 12, tileY: 4, type: 'object', id: 'theKiss', facingRequired: 'left' },
    { tileX: 12, tileY: 5, type: 'object', id: 'theKiss', facingRequired: 'left' },
    // Kintsugi cup on counter (approach from customer side row 3)
    { tileX: 5, tileY: 3, type: 'object', id: 'kintsugiCup' },
    // Vinyl record player (approach from below)
    { tileX: 10, tileY: 2, type: 'object', id: 'vinylPlayer', facingRequired: 'up' },
  ],

  // ─── NPC Seat Positions ───────────────────────────────────────
  seats: {
    cruz:    { tileX: 4,  tileY: 2, facing: 'down' },   // behind counter
    polaris: { tileX: 3,  tileY: 5, facing: 'down' },   // north star
    sirius:  { tileX: 6,  tileY: 5, facing: 'down' },   // sirius (天狼)
    mira:    { tileX: 9,  tileY: 5, facing: 'down' },   // mira
    nova:    { tileX: 3,  tileY: 6, facing: 'down' },   // nova (新星)
    rigel:   { tileX: 6,  tileY: 6, facing: 'down' },   // rigel (參宿)
    empty1:  { tileX: 9,  tileY: 6 },                    // available seat
    empty2:  { tileX: 3,  tileY: 7 },                    // available seat
    empty3:  { tileX: 6,  tileY: 7 },                    // available seat
    lastSeat:{ tileX: 9,  tileY: 7 },                    // last available seat
  },

  // ─── Special Objects ──────────────────────────────────────────
  objects: {
    newsWall:      { tileX: 2,  tileY: 9 },
    warRoomDoor:   { tileX: 6,  tileY: 9 },
    bookshelf:     { tileX: 12, tileY: 1 },
    cat:           { tileX: 12, tileY: 9 },
    coffeeMachine: { tileX: 7,  tileY: 2 },
    clock:         { tileX: 13, tileY: 0 },
    openSign:      { tileX: 13, tileY: 3 },
    coatRack:      { tileX: 13, tileY: 1 },
    entrance:      { tileX: 7,  tileY: 10 },  // player spawn point
    starryNight:   { tileX: 11, tileY: 0  },  // Van Gogh on north wall
    theKiss:       { tileX: 11, tileY: 4  },  // Klimt on east corridor
    kintsugiCup:   { tileX: 5,  tileY: 2  },  // Kintsugi cup on counter
    vinylPlayer:   { tileX: 10, tileY: 1  },  // Vinyl player on bar shelf
  },

  // ─── Tile Rendering Hints ─────────────────────────────────────
  tileStyles: {
    // Floor tiles
    0:  { fill: '#3e2723', name: 'wood_floor' },
    1:  { fill: '#2a1f14', name: 'dark_wood' },
    2:  { fill: '#4a3728', name: 'carpet' },
    3:  { fill: '#5d4037', name: 'counter_floor' },
    // Structure tiles
    10: { fill: '#5c3d2e', name: 'wall' },
    11: { fill: '#1a237e', name: 'window_night', effect: 'rain' },
    12: { fill: '#6d4c3d', name: 'counter', border: '#8d6e63' },
    13: { fill: '#4e342e', name: 'bookshelf', detail: 'books' },
    14: { fill: '#795548', name: 'chair', detail: 'cushion' },
    15: { fill: '#5d4037', name: 'table', border: '#4e342e' },
    16: { fill: '#33691e', name: 'entrance_door', detail: 'welcome_mat' },
    17: { fill: '#37474f', name: 'news_wall', detail: 'headlines' },
    18: { fill: '#263238', name: 'war_room_door', detail: 'classified' },
    19: { fill: '#1a237e', name: 'cat_windowsill', detail: 'cat_silhouette' },
    20: { fill: '#4e342e', name: 'coffee_machine', detail: 'steam' },
    21: { fill: '#5c3d2e', name: 'clock', detail: '11pm' },
    22: { fill: '#ff6f00', name: 'open_sign', detail: 'neon_glow' },
    23: { fill: '#6d4c3d', name: 'coat_rack' },
    24: { fill: '#6d4c3d', name: 'cruz_position' },
    25: { fill: '#3d2a1e', name: 'counter_front', border: '#6b4a35' },
    27: { fill: '#0a1a3a', name: 'starry_night_left', detail: 'van_gogh' },
    28: { fill: '#0a1a3a', name: 'starry_night_right', detail: 'van_gogh' },
    29: { fill: '#c8820a', name: 'the_kiss_top', detail: 'klimt' },
    30: { fill: '#c8820a', name: 'the_kiss_bottom', detail: 'klimt' },
    31: { fill: '#6d4c3d', name: 'kintsugi_cup', detail: 'gold_repair' },
    32: { fill: '#2a1808', name: 'vinyl_player', detail: 'bach_score' },
  },

  // ─── Pathfinding Validation Waypoints ─────────────────────────
  // Confirms a clear corridor exists: entrance -> all seats & objects
  // Walkable spine: column 1 (y:1-8), row 4 (x:1-13), row 8 (x:1-13)
  _walkableSpine: [
    // Vertical corridor on left (x=1, y=1..8)
    { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 },
    { x: 1, y: 5 }, { x: 1, y: 6 }, { x: 1, y: 7 }, { x: 1, y: 8 },
    // Horizontal corridor top (y=4, x=1..13)
    { x: 2, y: 4 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 },
    { x: 6, y: 4 }, { x: 7, y: 4 }, { x: 8, y: 4 }, { x: 9, y: 4 },
    { x: 10, y: 4 }, { x: 11, y: 4 }, { x: 12, y: 4 }, { x: 13, y: 4 },
    // Horizontal corridor bottom (y=8, x=1..13)
    { x: 2, y: 8 }, { x: 3, y: 8 }, { x: 4, y: 8 }, { x: 5, y: 8 },
    { x: 6, y: 8 }, { x: 7, y: 8 }, { x: 8, y: 8 }, { x: 9, y: 8 },
    { x: 10, y: 8 }, { x: 11, y: 8 }, { x: 12, y: 8 }, { x: 13, y: 8 },
    // Entrance approach (x=7, y=8..10)
    { x: 7, y: 9 }, { x: 7, y: 10 },
  ],
};
