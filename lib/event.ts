export const DEFAULT_EVENT = {
  name: "Hyphen Festival 2026",
  date: "2026-11-04",
  time: "09:30",
  endTime: "16:15",
  timeZone: "Europe/London",
  venue: "One Great George Street, London, United Kingdom",
  rsvpUrl: "https://events.hyphenonline.com/HyphenFestival2026#/buyTickets",
  badge: "Live Countdown",
  rsvpLabel: "RSVP - Open",
  scanLabel: "Scan to join",
  joinLabel: "Join Live",
  eventLink: "https://events.hyphenonline.com/HyphenFestival2026",
  xUrl: "https://x.com/onlinehyphen",
  facebookUrl: "https://facebook.com/onlinehyphen",
  linkedinUrl: "https://linkedin.com/company/hyphenonline",
  instagramUrl: "https://instagram.com/onlinehyphen?hl=en",
  youtubeUrl: "https://www.youtube.com/@hyphenonline",
} as const

export const TIME_ZONES = [
  { id: "Europe/Berlin", label: "Central Europe (CET/CEST)" },
  { id: "Europe/Bucharest", label: "Bucharest (EET/EEST)" },
  { id: "Europe/London", label: "London (GMT/BST)" },
  { id: "UTC", label: "UTC" },
  { id: "America/New_York", label: "New York (ET)" },
  { id: "America/Los_Angeles", label: "Los Angeles (PT)" },
] as const

export type EventConfig = {
  name: string
  date: string
  time: string
  endTime: string
  timeZone: string
  venue: string
  rsvpUrl: string
  badge: string
  rsvpLabel: string
  scanLabel: string
  joinLabel: string
  eventLink: string
  xUrl: string
  facebookUrl: string
  linkedinUrl: string
  instagramUrl: string
  youtubeUrl: string
}
