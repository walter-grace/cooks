/**
 * Phone-number presentation for the dialer: national formatting, country, and an "area code region"
 * (state or province + time zone) for North American numbers so the cockpit can show where a line is
 * ringing and what time it is there. The region table is approximate by design: area codes that span
 * time zones get their primary zone, and ported mobiles can live anywhere. A prospect's own `timezone`
 * always wins when set.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

export interface PhoneInfo {
  e164: string;
  national: string;
  international: string;
  country: CountryCode | null;
  areaCode: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  tollFree: boolean;
}

/** state/province → IANA zone (primary) → area codes. */
const NANP: Array<[string, string, string]> = [
  ['AL', 'America/Chicago', '205 251 256 334 659 938'],
  ['AK', 'America/Anchorage', '907'],
  ['AZ', 'America/Phoenix', '480 520 602 623 928'],
  ['AR', 'America/Chicago', '479 501 870'],
  ['CA', 'America/Los_Angeles', '209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951'],
  ['CO', 'America/Denver', '303 719 720 970 983'],
  ['CT', 'America/New_York', '203 475 860 959'],
  ['DE', 'America/New_York', '302'],
  ['DC', 'America/New_York', '202 771'],
  ['FL', 'America/New_York', '239 305 321 352 386 407 561 656 689 727 754 772 786 813 850 863 904 941 954'],
  ['GA', 'America/New_York', '229 404 470 478 678 706 762 770 912 943'],
  ['HI', 'Pacific/Honolulu', '808'],
  ['ID', 'America/Boise', '208 986'],
  ['IL', 'America/Chicago', '217 224 309 312 331 447 464 618 630 708 773 779 815 847 872'],
  ['IN', 'America/Indiana/Indianapolis', '219 260 317 463 574 765 812 930'],
  ['IA', 'America/Chicago', '319 515 563 641 712'],
  ['KS', 'America/Chicago', '316 620 785 913'],
  ['KY', 'America/New_York', '270 364 502 606 859'],
  ['LA', 'America/Chicago', '225 318 337 504 985'],
  ['ME', 'America/New_York', '207'],
  ['MD', 'America/New_York', '240 301 410 443 667'],
  ['MA', 'America/New_York', '339 351 413 508 617 774 781 857 978'],
  ['MI', 'America/Detroit', '231 248 269 313 517 586 616 679 734 810 906 947 989'],
  ['MN', 'America/Chicago', '218 320 507 612 651 763 952'],
  ['MS', 'America/Chicago', '228 601 662 769'],
  ['MO', 'America/Chicago', '314 417 557 573 636 660 816 975'],
  ['MT', 'America/Denver', '406'],
  ['NE', 'America/Chicago', '308 402 531'],
  ['NV', 'America/Los_Angeles', '702 725 775'],
  ['NH', 'America/New_York', '603'],
  ['NJ', 'America/New_York', '201 551 609 640 732 848 856 862 908 973'],
  ['NM', 'America/Denver', '505 575'],
  ['NY', 'America/New_York', '212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934'],
  ['NC', 'America/New_York', '252 336 472 704 743 828 910 919 980 984'],
  ['ND', 'America/Chicago', '701'],
  ['OH', 'America/New_York', '216 220 234 283 326 330 380 419 440 513 567 614 740 937'],
  ['OK', 'America/Chicago', '405 539 572 580 918'],
  ['OR', 'America/Los_Angeles', '458 503 541 971'],
  ['PA', 'America/New_York', '215 223 267 272 412 445 484 570 582 610 717 724 814 835 878'],
  ['RI', 'America/New_York', '401'],
  ['SC', 'America/New_York', '803 821 839 843 854 864'],
  ['SD', 'America/Chicago', '605'],
  ['TN', 'America/Chicago', '423 615 629 731 865 901 931'],
  ['TX', 'America/Chicago', '210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979'],
  ['UT', 'America/Denver', '385 435 801'],
  ['VT', 'America/New_York', '802'],
  ['VA', 'America/New_York', '276 434 540 571 686 703 757 804 826 948'],
  ['WA', 'America/Los_Angeles', '206 253 360 425 509 564'],
  ['WV', 'America/New_York', '304 681'],
  ['WI', 'America/Chicago', '262 274 353 414 534 608 715 920'],
  ['WY', 'America/Denver', '307'],
  ['AB', 'America/Edmonton', '368 403 587 780 825'],
  ['BC', 'America/Vancouver', '236 250 257 604 672 778'],
  ['MB', 'America/Winnipeg', '204 431 584'],
  ['NB', 'America/Moncton', '506'],
  ['NL', 'America/St_Johns', '709'],
  ['NS', 'America/Halifax', '782 902'],
  ['ON', 'America/Toronto', '226 249 289 343 365 382 416 437 519 548 613 647 683 705 742 753 807 905 942'],
  ['QC', 'America/Toronto', '263 354 367 418 438 450 468 514 579 581 819 873'],
  ['SK', 'America/Regina', '306 474 639'],
  ['NT', 'America/Yellowknife', '867'],
];
const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);
const CITY: Record<string, string> = {
  212: 'New York', 646: 'New York', 917: 'New York', 332: 'New York', 718: 'New York', 347: 'New York', 929: 'New York',
  213: 'Los Angeles', 323: 'Los Angeles', 310: 'Los Angeles', 424: 'Los Angeles', 818: 'Los Angeles', 747: 'Los Angeles',
  415: 'San Francisco', 628: 'San Francisco', 510: 'Oakland', 408: 'San Jose', 669: 'San Jose', 650: 'Palo Alto', 619: 'San Diego', 858: 'San Diego', 916: 'Sacramento',
  512: 'Austin', 737: 'Austin', 214: 'Dallas', 469: 'Dallas', 972: 'Dallas', 945: 'Dallas', 713: 'Houston', 281: 'Houston', 832: 'Houston', 346: 'Houston', 210: 'San Antonio', 726: 'San Antonio', 817: 'Fort Worth', 682: 'Fort Worth',
  312: 'Chicago', 773: 'Chicago', 872: 'Chicago', 847: 'Chicago area', 224: 'Chicago area', 617: 'Boston', 857: 'Boston',
  305: 'Miami', 786: 'Miami', 954: 'Fort Lauderdale', 754: 'Fort Lauderdale', 407: 'Orlando', 689: 'Orlando', 813: 'Tampa', 904: 'Jacksonville',
  404: 'Atlanta', 470: 'Atlanta', 678: 'Atlanta', 202: 'Washington', 703: 'Northern Virginia', 571: 'Northern Virginia', 301: 'Maryland suburbs', 240: 'Maryland suburbs',
  215: 'Philadelphia', 267: 'Philadelphia', 412: 'Pittsburgh', 206: 'Seattle', 425: 'Bellevue', 503: 'Portland', 971: 'Portland',
  303: 'Denver', 720: 'Denver', 602: 'Phoenix', 480: 'Phoenix', 623: 'Phoenix', 702: 'Las Vegas', 725: 'Las Vegas', 801: 'Salt Lake City', 385: 'Salt Lake City',
  612: 'Minneapolis', 651: 'St. Paul', 314: 'St. Louis', 816: 'Kansas City', 615: 'Nashville', 629: 'Nashville', 901: 'Memphis', 502: 'Louisville',
  513: 'Cincinnati', 216: 'Cleveland', 614: 'Columbus', 313: 'Detroit', 414: 'Milwaukee', 317: 'Indianapolis', 704: 'Charlotte', 980: 'Charlotte', 919: 'Raleigh', 984: 'Raleigh',
  804: 'Richmond', 757: 'Norfolk', 843: 'Charleston', 505: 'Albuquerque', 808: 'Honolulu', 907: 'Anchorage',
  416: 'Toronto', 647: 'Toronto', 437: 'Toronto', 514: 'Montreal', 438: 'Montreal', 604: 'Vancouver', 778: 'Vancouver', 236: 'Vancouver', 403: 'Calgary', 587: 'Calgary', 780: 'Edmonton', 613: 'Ottawa',
};
const AREA = new Map<string, { region: string; timezone: string }>();
for (const [region, timezone, codes] of NANP) for (const c of codes.split(' ')) AREA.set(c, { region, timezone });

export function phoneInfo(raw: string | null | undefined): PhoneInfo | null {
  if (!raw) return null;
  const p = parsePhoneNumberFromString(raw, 'US');
  if (!p) return null;
  const e164 = p.number;
  const country = (p.country ?? null) as CountryCode | null;
  let areaCode: string | null = null;
  if (p.countryCallingCode === '1' && p.nationalNumber.length === 10) areaCode = p.nationalNumber.slice(0, 3);
  const tollFree = !!areaCode && TOLL_FREE.has(areaCode);
  const a = areaCode ? AREA.get(areaCode) : undefined;
  return {
    e164,
    national: p.formatNational(),
    international: p.formatInternational(),
    country,
    areaCode,
    region: tollFree ? 'Toll-free' : (a?.region ?? null),
    city: areaCode ? (CITY[areaCode] ?? null) : null,
    timezone: a?.timezone ?? null,
    tollFree,
  };
}

/** "3:12 PM" in a zone, or null when the zone is unknown or invalid. */
export function localTime(timezone: string | null | undefined, now = new Date()): string | null {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(now);
  } catch {
    return null;
  }
}

/** Hour of day (0–23) in a zone, for the quiet-hours hint. */
export function localHour(timezone: string | null | undefined, now = new Date()): number | null {
  if (!timezone) return null;
  try {
    const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(now);
    const n = Number(h);
    return Number.isNaN(n) ? null : n % 24;
  } catch {
    return null;
  }
}

/** Short zone label like "CT" or "PT" when the browser can produce one. */
export function zoneAbbr(timezone: string | null | undefined, now = new Date()): string | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', timeZone: timezone }).formatToParts(now);
    return parts.find((x) => x.type === 'timeZoneName')?.value ?? null;
  } catch {
    return null;
  }
}
