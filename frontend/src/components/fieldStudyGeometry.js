// Coordinates were traced in the original aerial's pixel space. All surfaces
// share one viewBox so the reveal never shifts outlines relative to the photo.
export const studyWidth = 1672;
export const studyHeight = 941;

const pavementEdge = `M177 108 L373 108 L365 449 Q364 472 389 473
  L742 473 L743 581 H794 V473 H1139 Q1167 473 1167 448 L1159 108
  H1488 Q1528 108 1532 150 L1549 647 H1270 Q1244 647 1245 676
  L1250 860 L151 862 Q110 862 111 824 L137 151 Q139 112 177 108Z`;
const islandCurb = `M1359 254 L1405 254 Q1429 253 1431 278 L1438 466
  Q1440 496 1412 497 H1369 Q1340 496 1339 469 L1335 280 Q1335 257 1359 254Z`;

const sidewalk = `M376 101 H401 L402 140 H413 L406 398 Q402 431 433 432
  H719 L719 376 H815 L816 432 H1096 Q1127 432 1126 405 L1124 144
  H1130 V102 H1153 L1162 448 Q1163 467 1139 467 H804 Q791 467 791 477
  V580 H745 L744 477 Q745 467 730 467 H391 Q369 467 370 449Z`;
const lawnPerimeter = `M0 0 H1672 V941 H0Z M175 97 H415 L417 52 L1110 53
  L1114 97 H1490 Q1540 98 1544 151 L1569 818 Q1571 867 1525 869
  L153 873 Q99 874 102 824 L127 149 Q129 102 175 97Z`;
const plantedBeds = `M410 280 L438 366 L718 369 V429 H436 Q405 429 407 399Z
  M818 371 L1096 361 L1124 349 L1125 405 Q1125 428 1096 430 H818Z
  M1361 260 H1404 Q1423 259 1425 280 L1431 467 Q1433 489 1411 489
  H1368 Q1347 487 1347 467 L1342 280 Q1342 262 1361 260Z
  M1272 655 L1550 655 L1559 818 Q1560 847 1532 849 L1260 847
  L1254 677 Q1253 656 1272 655Z`;

export const studyLayers = [
  { key: "pavement", label: "Plowable pavement", color: "#4289fa", path: pavementEdge + " " + islandCurb },
  { key: "sidewalks", label: "Sidewalks", color: "#ffd34d", path: sidewalk },
  { key: "turf", label: "Turf", color: "#79c74c", path: lawnPerimeter },
  { key: "mulch", label: "Mulch beds", color: "#f08346", path: plantedBeds },
];
