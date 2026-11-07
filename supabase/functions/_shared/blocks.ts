// Builder blocks: the catalogue the Builder tab offers, and how a design's
// blocks become a research brief. Pure, so the web app shows the same brief
// the agent receives.

export type ParamType = 'number' | 'money' | 'text' | 'select' | 'multi' | 'bool' | 'niche' | 'places' | 'countries';

export interface Param {
  key: string;
  label: string;
  type: ParamType;
  options?: string[];
  default?: unknown;
  unit?: string;
  placeholder?: string;
}

export type Category = 'concept' | 'offers' | 'facilities' | 'site' | 'money' | 'operations' | 'research';

export interface BlockDef {
  type: string;
  category: Category;
  label: string;
  hint: string;
  params: Param[];
  /** Only one of this block per design. */
  single?: boolean;
}

export interface BlockInstance {
  uid: string;
  type: string;
  params: Record<string, unknown>;
}

export const CATEGORIES: { key: Category; label: string; hint: string }[] = [
  { key: 'concept', label: 'Concept', hint: 'What it is and who it is for' },
  { key: 'offers', label: 'Offers', hint: 'What guests pay for' },
  { key: 'facilities', label: 'Facilities', hint: 'What gets built or installed' },
  { key: 'site', label: 'Site and place', hint: 'Land, features, where to look' },
  { key: 'money', label: 'Property and money', hint: 'Buy, rent land or lease; budget; financing' },
  { key: 'operations', label: 'Operations', hint: 'Who runs it, when it is open, how it sells' },
  { key: 'research', label: 'Research asks', hint: 'What the researcher should find out' },
];

const AUDIENCES = ['Locals within 40 minutes', 'Weekend city visitors', 'International travellers', 'Couples', 'Solo travellers', "Women's groups", 'Corporate teams', 'Athletes', 'Seniors 55+', 'Families', 'Remote workers', 'Wellness practitioners'];
const STAY_TYPES = ['Cabins', 'Geodesic domes', 'Glamping tents', 'Yurts', 'Treehouses', 'Rooms in a main house', 'Tiny homes', 'A-frames', 'Dark-retreat rooms', 'Earth-sheltered pods'];

export const BLOCKS: BlockDef[] = [
  // Concept
  { type: 'base_niche', category: 'concept', single: true, label: 'Start from a niche', hint: 'Build on an existing niche in your library', params: [{ key: 'niche', label: 'Niche', type: 'niche' }] },
  { type: 'theme', category: 'concept', single: true, label: 'Theme and positioning', hint: 'The idea in a sentence', params: [{ key: 'text', label: 'Theme', type: 'text', placeholder: 'e.g. Japanese onsen-inspired forest bathhouse' }] },
  { type: 'audience', category: 'concept', single: true, label: 'Who it is for', hint: 'Guests you want to attract', params: [{ key: 'who', label: 'Audience', type: 'multi', options: AUDIENCES }] },
  { type: 'price_tier', category: 'concept', single: true, label: 'Price level', hint: 'Where it sits on price', params: [{ key: 'tier', label: 'Level', type: 'select', options: ['Budget', 'Mid-range', 'Premium', 'Luxury'], default: 'Mid-range' }] },
  { type: 'signature', category: 'concept', label: 'Signature experience', hint: 'The thing people talk about', params: [{ key: 'text', label: 'Experience', type: 'text', placeholder: 'e.g. fire-and-ice ritual at sunset' }] },
  { type: 'visit_length', category: 'concept', single: true, label: 'Typical visit', hint: 'How long a guest stays', params: [{ key: 'length', label: 'Visit', type: 'select', options: ['2-hour visit', 'Half day', 'Full day', '1 night', 'Weekend', '3-5 nights', 'A week or more'], default: 'Weekend' }] },

  // Offers
  { type: 'stays', category: 'offers', label: 'Overnight stays', hint: 'Units guests sleep in', params: [{ key: 'kind', label: 'Type', type: 'select', options: STAY_TYPES, default: 'Cabins' }, { key: 'units', label: 'Units', type: 'number', default: 4 }, { key: 'price', label: 'Price per night', type: 'money' }] },
  { type: 'day_pass', category: 'offers', label: 'Day passes or entry', hint: 'Bathhouse, spa or grounds entry', params: [{ key: 'capacity', label: 'Guests per day', type: 'number', default: 20 }, { key: 'price', label: 'Price per visit', type: 'money' }] },
  { type: 'sessions', category: 'offers', label: 'Sessions and treatments', hint: 'Booked one-to-one or small group', params: [{ key: 'kinds', label: 'Kinds', type: 'multi', options: ['Sound bath', 'Massage', 'Float', 'Breathwork', 'Guided cold plunge', 'Yoga', 'Meditation', 'Reiki', 'Facials and body treatments', 'Forest bathing walk'] }, { key: 'per_week', label: 'Sessions per week', type: 'number', default: 15 }, { key: 'price', label: 'Price per session', type: 'money' }] },
  { type: 'memberships', category: 'offers', label: 'Memberships', hint: 'Recurring local members', params: [{ key: 'members', label: 'Members', type: 'number', default: 50 }, { key: 'price', label: 'Monthly price', type: 'money' }] },
  { type: 'retreats', category: 'offers', label: 'Hosted multi-day retreats', hint: 'Packages with lodging and program', params: [{ key: 'per_year', label: 'Retreats per year', type: 'number', default: 8 }, { key: 'guests', label: 'Guests each', type: 'number', default: 10 }, { key: 'price', label: 'Price per guest', type: 'money' }] },
  { type: 'workshops', category: 'offers', label: 'Workshops and classes', hint: 'Short courses and classes', params: [{ key: 'per_month', label: 'Per month', type: 'number', default: 4 }, { key: 'seats', label: 'Seats', type: 'number', default: 10 }, { key: 'price', label: 'Price per seat', type: 'money' }] },
  { type: 'venue', category: 'offers', label: 'Venue hire and events', hint: 'Weddings, ceremonies, private events', params: [{ key: 'per_year', label: 'Events per year', type: 'number', default: 12 }, { key: 'price', label: 'Price per event', type: 'money' }] },
  { type: 'corporate', category: 'offers', label: 'Corporate offsites', hint: 'Team days and leadership retreats', params: [{ key: 'per_year', label: 'Groups per year', type: 'number', default: 6 }, { key: 'price', label: 'Price per group', type: 'money' }] },
  { type: 'food', category: 'offers', label: 'Food and drink', hint: 'Tea house, café or guest meals', params: [{ key: 'kind', label: 'Type', type: 'select', options: ['Tea house', 'Café', 'Juice and tonic bar', 'Meals for staying guests', 'Farm-to-table dinners'], default: 'Tea house' }, { key: 'price', label: 'Average spend', type: 'money' }] },
  { type: 'retail', category: 'offers', label: 'Shop and products', hint: 'Things guests take home', params: [{ key: 'text', label: 'What', type: 'text', placeholder: 'e.g. herbal blends, local ceramics' }] },
  { type: 'digital', category: 'offers', label: 'Online programs', hint: 'Courses or memberships online', params: [{ key: 'text', label: 'What', type: 'text' }] },
  { type: 'addons', category: 'offers', label: 'Add-on experiences', hint: 'Extras sold to guests', params: [{ key: 'kinds', label: 'Add-ons', type: 'multi', options: ['Guided hikes', 'Horse riding', 'Farm tours', 'Stargazing', 'Foraging', 'Art class', 'Cooking class', 'Private chef', 'Transfers'] }] },
  { type: 'custom_offer', category: 'offers', label: 'Custom offer', hint: 'Anything else guests pay for', params: [{ key: 'label', label: 'Offer', type: 'text' }, { key: 'units', label: 'Capacity', type: 'number' }, { key: 'price', label: 'Price', type: 'money' }, { key: 'per', label: 'Per', type: 'text', placeholder: 'e.g. per person per day' }] },

  // Facilities
  { type: 'sauna', category: 'facilities', label: 'Sauna', hint: 'Heat', params: [{ key: 'count', label: 'How many', type: 'number', default: 1 }, { key: 'kind', label: 'Type', type: 'select', options: ['Wood-fired barrel', 'Cabin sauna', 'Panoramic glass-front', 'Mobile trailer'], default: 'Cabin sauna' }] },
  { type: 'cold_plunge', category: 'facilities', label: 'Cold plunge', hint: 'Cold', params: [{ key: 'count', label: 'How many', type: 'number', default: 2 }] },
  { type: 'soaking_pools', category: 'facilities', label: 'Soaking pools or hot tubs', hint: 'Warm water', params: [{ key: 'count', label: 'How many', type: 'number', default: 2 }, { key: 'heated', label: 'Heated', type: 'bool', default: true }] },
  { type: 'hot_spring', category: 'facilities', single: true, label: 'Natural hot spring', hint: 'Must exist on or next to the site', params: [{ key: 'required', label: 'Required', type: 'bool', default: true }] },
  { type: 'dome', category: 'facilities', label: 'Dome', hint: 'Sound, yoga or sleeping dome', params: [{ key: 'count', label: 'How many', type: 'number', default: 1 }, { key: 'use', label: 'Used for', type: 'select', options: ['Sound healing', 'Yoga and movement', 'Sleeping', 'Events'], default: 'Sound healing' }] },
  { type: 'bathhouse', category: 'facilities', single: true, label: 'Bathhouse building', hint: 'Changing rooms, showers, relaxation', params: [{ key: 'sqft', label: 'Size', type: 'number', unit: 'sq ft', default: 1500 }] },
  { type: 'studio', category: 'facilities', label: 'Studio or shala', hint: 'Classes and practice', params: [{ key: 'sqft', label: 'Size', type: 'number', unit: 'sq ft', default: 800 }] },
  { type: 'float_tanks', category: 'facilities', label: 'Float tanks', hint: 'Sensory deprivation', params: [{ key: 'count', label: 'How many', type: 'number', default: 2 }] },
  { type: 'dark_rooms', category: 'facilities', label: 'Dark-retreat rooms', hint: 'Fully light-sealed rooms', params: [{ key: 'count', label: 'How many', type: 'number', default: 3 }] },
  { type: 'treatment_rooms', category: 'facilities', label: 'Treatment rooms', hint: 'Massage and therapy', params: [{ key: 'count', label: 'How many', type: 'number', default: 2 }] },
  { type: 'event_space', category: 'facilities', label: 'Event space', hint: 'Barn, pavilion or hall', params: [{ key: 'capacity', label: 'Guests', type: 'number', default: 60 }] },
  { type: 'kitchen', category: 'facilities', single: true, label: 'Kitchen', hint: 'For guests or a café', params: [{ key: 'kind', label: 'Type', type: 'select', options: ['Guest kitchen', 'Commercial kitchen'], default: 'Guest kitchen' }] },
  { type: 'gardens', category: 'facilities', label: 'Gardens or farm', hint: 'Grow food, herbs or flowers', params: [{ key: 'acres', label: 'Acres', type: 'number', default: 1 }] },
  { type: 'trails', category: 'facilities', label: 'Trails', hint: 'Walking and forest-bathing paths', params: [{ key: 'miles', label: 'Miles', type: 'number', default: 1 }] },
  { type: 'meditation_garden', category: 'facilities', label: 'Meditation garden or labyrinth', hint: 'Quiet outdoor space', params: [] },
  { type: 'water_access', category: 'facilities', single: true, label: 'Water access', hint: 'River, lake or ocean on site', params: [{ key: 'kind', label: 'Water', type: 'select', options: ['Creek or river', 'Lake or pond', 'Ocean', 'Waterfall'], default: 'Creek or river' }] },
  { type: 'parking', category: 'facilities', single: true, label: 'Parking', hint: 'For day visitors', params: [{ key: 'spaces', label: 'Spaces', type: 'number', default: 20 }] },
  { type: 'off_grid', category: 'facilities', single: true, label: 'Off-grid systems', hint: 'Solar, well, septic', params: [{ key: 'kinds', label: 'Systems', type: 'multi', options: ['Solar power', 'Battery storage', 'Well water', 'Rainwater', 'Septic', 'Composting toilets'] }] },
  { type: 'owner_home', category: 'facilities', single: true, label: 'Owner home on site', hint: 'Where you live', params: [{ key: 'bedrooms', label: 'Bedrooms', type: 'number', default: 2 }] },
  { type: 'custom_facility', category: 'facilities', label: 'Custom facility', hint: 'Anything else to build', params: [{ key: 'label', label: 'Facility', type: 'text' }, { key: 'count', label: 'How many', type: 'number', default: 1 }, { key: 'cost', label: 'Rough cost each', type: 'money' }] },

  // Site and place
  { type: 'site_type', category: 'site', single: true, label: 'Kind of site', hint: 'Decides which lease is used', params: [{ key: 'kind', label: 'Site', type: 'select', options: ['A house with land', 'A public-facing commercial property', 'A large estate (20+ acres)'], default: 'A house with land' }] },
  { type: 'acres', category: 'site', single: true, label: 'Land size', hint: 'How much land', params: [{ key: 'acres', label: 'Acres', type: 'number', default: 5 }] },
  { type: 'features', category: 'site', single: true, label: 'Natural features', hint: 'What the land should have', params: [{ key: 'kinds', label: 'Features', type: 'multi', options: ['Forest', 'Creek or river', 'Lake', 'Mountain views', 'Ocean nearby', 'Hot spring', 'Waterfall', 'Dark skies', 'Cool climate', 'Warm climate', 'Privacy'] }] },
  { type: 'access', category: 'site', single: true, label: 'Access', hint: 'How far guests travel', params: [{ key: 'airport', label: 'Max minutes to an international airport', type: 'number', default: 120 }, { key: 'city', label: 'Max minutes to a city', type: 'number', default: 60 }] },
  { type: 'permissions', category: 'site', single: true, label: 'Permissions needed', hint: 'What zoning must allow', params: [{ key: 'kinds', label: 'Allowed uses', type: 'multi', options: ['Commercial use', 'Short-term rentals', 'Events', 'Food service', 'Agriculture', 'Camping or glamping'] }] },
  { type: 'countries', category: 'site', single: true, label: 'Countries', hint: 'Where to look', params: [{ key: 'codes', label: 'Countries', type: 'countries' }] },
  { type: 'places', category: 'site', single: true, label: 'Specific places', hint: 'Places to focus on', params: [{ key: 'ids', label: 'Places', type: 'places' }] },

  // Property and money
  { type: 'property', category: 'money', single: true, label: 'Property', hint: 'How you hold the site', params: [{ key: 'choice', label: 'Choice', type: 'select', options: ['Compare all three', 'Buy land and build', 'Rent land and build my own', 'Lease an existing property'], default: 'Compare all three' }] },
  { type: 'budget', category: 'money', single: true, label: 'Budget cap', hint: 'Most the project may cost', params: [{ key: 'usd', label: 'Total project', type: 'money', default: 400000 }] },
  { type: 'financing', category: 'money', single: true, label: 'Financing', hint: 'How it is paid for', params: [{ key: 'kinds', label: 'Financing', type: 'multi', options: ['SBA or bank loan (USA)', 'SBA 7(a) for a lease (USA)', 'Seller financing (abroad)', 'Cash only', 'Partner or investor'] }] },
  { type: 'live_on_site', category: 'money', single: true, label: 'Live on site', hint: 'You live there', params: [{ key: 'housing', label: 'Housing cost you would stop paying', type: 'money' }] },
  { type: 'phases', category: 'money', label: 'Build in phases', hint: 'Start small, add later', params: [{ key: 'text', label: 'Phase plan', type: 'text', placeholder: 'e.g. year 1: 2 domes and sauna; year 2: 4 more domes' }] },
  { type: 'target', category: 'money', single: true, label: 'Income goal', hint: 'What it must pay you', params: [{ key: 'usd', label: 'Take-home per month', type: 'money', default: 5000 }, { key: 'year', label: 'By year', type: 'select', options: ['1', '3'], default: '1' }] },

  // Operations
  { type: 'staffing', category: 'operations', single: true, label: 'Who runs it', hint: 'Owner, partner, team', params: [{ key: 'model', label: 'Staffing', type: 'select', options: ['Just me', 'Me and a partner', 'Me plus part-time help', 'A small team'], default: 'Just me' }] },
  { type: 'hours', category: 'operations', single: true, label: 'Opening hours', hint: 'When guests are served', params: [{ key: 'days', label: 'Days a week', type: 'number', default: 5 }, { key: 'hours', label: 'Hours a day', type: 'number', default: 8 }] },
  { type: 'season', category: 'operations', single: true, label: 'Season', hint: 'When it is open', params: [{ key: 'kind', label: 'Season', type: 'select', options: ['Year-round', 'Closed in winter', 'Closed in rainy season', 'Summer only'], default: 'Year-round' }] },
  { type: 'channels', category: 'operations', single: true, label: 'Sales channels', hint: 'Where bookings come from', params: [{ key: 'kinds', label: 'Channels', type: 'multi', options: ['Own website', 'Airbnb', 'Booking.com', 'Hipcamp', 'Glamping Hub', 'ClassPass', 'Mindbody', 'Retreat platforms', 'Local partners'] }] },
  { type: 'practitioners', category: 'operations', single: true, label: 'Practitioners', hint: 'Who delivers sessions', params: [{ key: 'kind', label: 'Model', type: 'select', options: ['I deliver them', 'Contractors on revenue share', 'Employed staff'], default: 'Contractors on revenue share' }] },
  { type: 'partnerships', category: 'operations', label: 'Partnerships', hint: 'Who you work with', params: [{ key: 'text', label: 'Partners', type: 'text', placeholder: 'e.g. local hotels send guests for day passes' }] },
  { type: 'sustainability', category: 'operations', single: true, label: 'Sustainability', hint: 'How green it is', params: [{ key: 'kinds', label: 'Practices', type: 'multi', options: ['Solar', 'Rainwater', 'Compost', 'Regenerative farming', 'Zero waste', 'Natural building'] }] },

  // Research asks
  { type: 'find_comparables', category: 'research', single: true, label: 'Find comparable businesses', hint: 'Real operators of this mix', params: [{ key: 'count', label: 'How many', type: 'number', default: 10 }, { key: 'where', label: 'Where', type: 'text', placeholder: 'e.g. anywhere in the Americas' }] },
  { type: 'price_check', category: 'research', label: 'Check real prices', hint: 'What operators charge', params: [{ key: 'text', label: 'For', type: 'text', placeholder: 'e.g. dome stays and sound baths' }] },
  { type: 'demand_check', category: 'research', single: true, label: 'Measure demand', hint: 'Evidence people buy this', params: [{ key: 'kinds', label: 'Evidence', type: 'multi', options: ['Review counts of comparables', 'Sold-out or waitlist signals', 'Local visitor numbers', 'Competitors nearby', 'Search interest'] }] },
  { type: 'permits_check', category: 'research', label: 'Check permits and rules', hint: 'What is needed to open', params: [{ key: 'text', label: 'For', type: 'text', placeholder: 'e.g. short-term rental and sauna rules' }] },
  { type: 'question', category: 'research', label: 'Ask the researcher', hint: 'Any question, answered with sources', params: [{ key: 'text', label: 'Question', type: 'text', placeholder: 'e.g. what do the best sauna villages charge for memberships?' }] },
  { type: 'compare_niche', category: 'research', label: 'Compare with a niche', hint: 'Side-by-side with one you have', params: [{ key: 'niche', label: 'Niche', type: 'niche' }] },
  { type: 'exclude', category: 'research', single: true, label: 'Avoid', hint: 'Things to leave out', params: [{ key: 'text', label: 'Avoid', type: 'text', placeholder: 'e.g. anything needing a medical licence' }] },
];

export const BLOCK = Object.fromEntries(BLOCKS.map((b) => [b.type, b])) as Record<string, BlockDef>;

const has = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
const usd = (v: unknown) => `$${Number(v).toLocaleString('en-US')}`;

/** One readable line per block, e.g. "Overnight stays: 4 geodesic domes at about $220 a night". */
export function describeBlock(b: BlockInstance, names: { niches?: Record<string, string>; places?: Record<string, string> } = {}): string {
  const def = BLOCK[b.type];
  if (!def) return '';
  const p = b.params ?? {};
  const parts: string[] = [];
  for (const param of def.params) {
    const v = p[param.key] ?? param.default;
    if (!has(v)) continue;
    if (param.type === 'money') parts.push(`${param.label.toLowerCase()} ${usd(v)}`);
    else if (param.type === 'bool') parts.push(v ? param.label.toLowerCase() : `not ${param.label.toLowerCase()}`);
    else if (param.type === 'niche') parts.push(names.niches?.[String(v)] ?? String(v));
    else if (param.type === 'places') parts.push((v as string[]).map((id) => names.places?.[id] ?? id).join(', '));
    else if (Array.isArray(v)) parts.push(v.join(', '));
    else if (param.type === 'number') parts.push(`${param.label.toLowerCase()} ${v}${param.unit ? ` ${param.unit}` : ''}`);
    else parts.push(String(v));
  }
  return `${def.label}${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

export interface Brief {
  /** The full brief the researcher works from. */
  text: string;
  /** A short summary for the niche card. */
  summary: string;
  /** Searches the design asks for, beyond the standard write-up searches. */
  queries: string[];
  /** Questions to answer with sources. */
  questions: string[];
  /** Places or countries to focus screening on (informational). */
  countries: string[];
  placeIds: string[];
  baseNicheId: string | null;
}

/** Turn a design's blocks into the brief the research agent works from. */
export function composeBrief(name: string, blocks: BlockInstance[], names: { niches?: Record<string, string>; places?: Record<string, string> } = {}): Brief {
  const by = (cat: Category) => blocks.filter((b) => BLOCK[b.type]?.category === cat);
  const section = (cat: Category) => {
    const lines = by(cat).map((b) => describeBlock(b, names)).filter(Boolean);
    const label = CATEGORIES.find((c) => c.key === cat)!.label;
    return lines.length ? `${label}:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
  };
  const get = (type: string) => blocks.find((b) => b.type === type)?.params ?? {};
  const theme = String(get('theme').text ?? '').trim();
  const offers = by('offers').map((b) => describeBlock(b, names));
  const facilities = by('facilities').map((b) => BLOCK[b.type].label.toLowerCase());
  const questions = blocks
    .filter((b) => ['question', 'price_check', 'permits_check'].includes(b.type) && has(b.params?.text))
    .map((b) => (b.type === 'price_check' ? `What do real operators charge for ${b.params.text}? Give prices with sources.` : b.type === 'permits_check' ? `What permits and rules apply to ${b.params.text}?` : String(b.params.text)));
  for (const b of blocks.filter((x) => x.type === 'compare_niche' && has(x.params?.niche))) {
    questions.push(`How does this design compare with the "${names.niches?.[String(b.params.niche)] ?? 'other'}" niche on prices, build cost and demand?`);
  }
  const comparables = get('find_comparables');
  const queries = [
    theme && `${theme} wellness business`,
    offers.length > 1 && `${facilities.slice(0, 3).join(' ')} wellness retreat prices`,
    blocks.some((b) => b.type === 'find_comparables') && `${theme || name} ${String(comparables.where ?? '')} similar businesses`.trim(),
    ...by('offers').filter((b) => b.type === 'stays').map((b) => `${String(b.params?.kind ?? 'cabin')} rental wellness retreat price per night`),
  ].filter(Boolean) as string[];
  const text = [
    `Design: ${name}`,
    theme && `Theme: ${theme}`,
    ...(['concept', 'offers', 'facilities', 'site', 'money', 'operations'] as Category[]).map(section),
    questions.length ? `Questions to answer:\n${questions.map((q) => `- ${q}`).join('\n')}` : '',
    has(get('exclude').text) ? `Leave out: ${get('exclude').text}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const summary = [theme || name, offers.length ? `Offers: ${offers.map((o) => o.split(':')[0]).join(', ')}` : '', facilities.length ? `Facilities: ${facilities.join(', ')}` : '']
    .filter(Boolean)
    .join('. ');
  return {
    text,
    summary,
    queries: [...new Set(queries)].slice(0, 5),
    questions: questions.slice(0, 6),
    countries: (get('countries').codes as string[] | undefined) ?? [],
    placeIds: (get('places').ids as string[] | undefined) ?? [],
    baseNicheId: (get('base_niche').niche as string | undefined) ?? null,
  };
}
