// Known land- or structure-based wellness formats that operate somewhere in
// the world. Never shown to the niche scout: the brainstorm is graded on how
// many of these its library ends up covering (recall), so this list must stay
// out of every prompt and playbook.

export interface HeldOutNiche {
  name: string;
  /** Words or phrases that identify the format in a niche's name, aliases or description. */
  match: string[];
}

export const HELD_OUT_NICHES: HeldOutNiche[] = [
  { name: 'Japanese onsen-style bathhouse', match: ['onsen', 'ryokan', 'sento'] },
  { name: 'Korean jjimjilbang', match: ['jjimjilbang', 'korean spa', 'korean bathhouse'] },
  { name: 'Russian banya', match: ['banya', 'venik'] },
  { name: 'Baltic pirts sauna ritual', match: ['pirts', 'baltic sauna', 'sauna ritual', 'saunagus', 'aufguss'] },
  { name: 'Turkish hammam', match: ['hammam', 'hamam'] },
  { name: 'Mesoamerican temazcal', match: ['temazcal'] },
  { name: 'Floating sauna', match: ['floating sauna', 'sauna boat', 'sauna raft'] },
  { name: 'Kneipp water-treading trail', match: ['kneipp', 'water treading', 'water-treading'] },
  { name: 'Barefoot park', match: ['barefoot park', 'barefoot trail', 'barfuss', 'barefoot path'] },
  { name: 'Salt cave / halotherapy', match: ['salt cave', 'halotherapy', 'salt room', 'speleotherapy'] },
  { name: 'Hay bath', match: ['hay bath', 'heubad', 'hay sauna'] },
  { name: 'Beer spa', match: ['beer spa', 'beer bath'] },
  { name: 'Mud bath / thermal mud spa', match: ['mud bath', 'mud spa', 'fango', 'peloid'] },
  { name: 'Treehouse retreat', match: ['treehouse', 'tree house'] },
  { name: 'Yoga retreat center', match: ['yoga retreat', 'yoga center', 'yoga centre', 'yoga shala'] },
  { name: 'Silent meditation retreat', match: ['silent retreat', 'vipassana', 'silent meditation'] },
  { name: 'Dark retreat', match: ['dark retreat', 'darkness retreat', 'darkroom'] },
  { name: 'Float tank center', match: ['float tank', 'float spa', 'sensory deprivation', 'flotation'] },
  { name: 'Forest bathing', match: ['forest bathing', 'shinrin', 'forest therapy'] },
  { name: 'Hot springs', match: ['hot spring', 'thermal spring', 'termales', 'geothermal pool'] },
  { name: 'Wild swimming with lakeside sauna', match: ['wild swimming', 'lake sauna', 'lakeside sauna', 'cold water swimming', 'open water swim'] },
  { name: 'Equine-assisted therapy', match: ['equine', 'horse therapy', 'horse-assisted'] },
  { name: 'Labyrinth walking garden', match: ['labyrinth'] },
  { name: 'Lavender or herb farm stay', match: ['lavender farm', 'herb farm', 'aromatherapy farm', 'botanical farm stay'] },
  { name: 'Tea ceremony or tea farm retreat', match: ['tea ceremony', 'tea farm', 'tea retreat', 'tea plantation stay'] },
  { name: 'Martial arts training camp', match: ['muay thai camp', 'kung fu', 'shaolin', 'martial arts camp', 'martial arts retreat'] },
  { name: 'Surf and yoga camp', match: ['surf camp', 'surf and yoga', 'surf retreat'] },
  { name: 'Monastery or hermitage stay', match: ['monastery stay', 'hermitage', 'cloister', 'retreat house'] },
  { name: 'Beehive air therapy (apitherapy)', match: ['apitherapy', 'beehive air', 'bee hive inhalation', 'bee sauna', 'apiary therapy'] },
  { name: 'Contrast-therapy bathhouse', match: ['contrast therapy', 'cold plunge', 'bathhouse'] },
];
