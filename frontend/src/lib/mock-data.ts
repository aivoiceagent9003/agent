// Mock data + types matching the spec. Replace with real API calls when backend is ready.
export type Sentiment = "positive" | "neutral" | "frustrated" | "angry";

export interface Tenant {
  id: string;
  name: string;
  phone_number: string;
  config: {
    business_name: string;
    agent_name: string;
    purpose: string;
    handoff_number: string;
    enable_handoff: boolean;
    enable_kb: boolean;
    filler_phrases: string[];
    max_sentences: number;
  };
  created_at: string;
}

export interface Call {
  id: string;
  caller_number: string;
  status: "completed" | "active";
  duration_seconds: number;
  transcript: string;
  recording_url?: string | null;
  created_at: string;
  has_lead: boolean;
}

export interface Lead {
  id: string;
  name: string | null;
  intent: string;
  summary: string;
  sentiment: Sentiment;
  language: string;
  key_details: string[];
  follow_up_needed: boolean;
  handed_off: boolean;
  contact_info: string | null;
  caller_number: string;
  call_id?: string | null;
  created_at: string;
  transcript?: string | null;
  // Workflow fields — a lead is worked by a person, not just captured.
  // See sql/team.sql and PATCH /api/client/leads/:id.
  status?: "new" | "contacted" | "converted" | "lost";
  assigned_to?: string | null;
  notes?: string | null;
  updated_at?: string | null;
  // Full extraction JSON — includes the interest signals the extractor produces.
  raw_data?: {
    is_lead?: boolean;
    interest_score?: number;
    interest_reason?: string;
    [k: string]: unknown;
  } | null;
}

const now = Date.now();
const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();

export const mockCalls: Call[] = Array.from({ length: 24 }).map((_, i) => ({
  id: `call_${i + 1}`,
  caller_number: `+1${(5550100 + i).toString().padStart(7, "0")}`,
  status: i === 0 ? "active" : "completed",
  duration_seconds: 60 + Math.floor(Math.random() * 480),
  transcript: [
    "[Caller] Hi, I'm looking for a 2 bedroom apartment downtown.",
    "[Agent] Of course! What's your budget range and preferred move-in date?",
    "[Caller] Around $2,500 per month, ideally next month.",
    "[Agent] Great. I have a few listings that match. Can I get your name and email to send the details?",
    "[Caller] Sure, it's Priya Sharma, priya@example.com.",
    "[Agent] Thank you, Priya. You'll receive an email shortly. Anything else?",
    "[Caller] No, that's perfect.",
    "[Agent] Have a great day!",
  ].join("\n"),
  created_at: daysAgo(i / 3),
  has_lead: i % 3 !== 0,
}));

export const mockLeads: Lead[] = mockCalls
  .filter((c) => c.has_lead)
  .map((c, i) => ({
    id: `lead_${i + 1}`,
    name: ["Priya Sharma", "Marcus Lee", "Aisha Khan", "David Chen", null][i % 5],
    intent: ["apartment_inquiry", "appointment_booking", "pricing_question", "support", "general"][
      i % 5
    ],
    summary: "Caller wants a 2BR downtown apartment, $2,500/mo, move-in next month.",
    sentiment: (["positive", "neutral", "frustrated", "positive", "angry"] as Sentiment[])[i % 5],
    language: ["en", "hi", "es", "en", "en"][i % 5],
    key_details: ["2 bedrooms", "Downtown", "$2,500 budget", "Move-in next month"],
    follow_up_needed: i % 2 === 0,
    handed_off: i % 4 === 0,
    contact_info: [
      "priya@example.com",
      "+15551234567",
      "aisha@example.com",
      null,
      "david@example.com",
    ][i % 5],
    caller_number: c.caller_number,
    created_at: c.created_at,
  }));

export const mockOverview = {
  total_calls: mockCalls.length,
  total_minutes: Math.round(mockCalls.reduce((s, c) => s + c.duration_seconds, 0) / 60),
  total_leads: mockLeads.length,
  handoff_count: mockLeads.filter((l) => l.handed_off).length,
  avg_duration_seconds: Math.round(
    mockCalls.reduce((s, c) => s + c.duration_seconds, 0) / mockCalls.length,
  ),
};

export const mockCallsPerDay = Array.from({ length: 7 }).map((_, i) => ({
  day: new Date(now - (6 - i) * 86400000).toLocaleDateString("en", { weekday: "short" }),
  calls: 3 + Math.floor(Math.random() * 12),
}));

export const mockTenants: Tenant[] = [
  {
    id: "t_1",
    name: "Sunrise Realty",
    phone_number: "+15550100001",
    config: {
      business_name: "Sunrise Realty",
      agent_name: "Aria",
      purpose: "Answer leasing inquiries and qualify leads.",
      handoff_number: "+15550199999",
      enable_handoff: true,
      enable_kb: true,
      filler_phrases: ["Let me check that", "One moment"],
      max_sentences: 2,
    },
    created_at: daysAgo(30),
  },
  {
    id: "t_2",
    name: "MediCare Hospital",
    phone_number: "+15550100002",
    config: {
      business_name: "MediCare Hospital",
      agent_name: "Nova",
      purpose: "Book appointments and triage requests.",
      handoff_number: "+15550199998",
      enable_handoff: true,
      enable_kb: true,
      filler_phrases: ["Got it", "Sure thing"],
      max_sentences: 3,
    },
    created_at: daysAgo(60),
  },
];

export const industryDemos = [
  {
    id: "real_estate",
    title: "Real Estate",
    description: "Qualify renters and buyers 24/7.",
    emoji: "🏠",
    script: [
      { who: "caller" as const, text: "Hi, I'm looking for a 2 bedroom apartment downtown." },
      { who: "agent" as const, text: "Of course! What's your budget and move-in date?" },
      { who: "caller" as const, text: "Around $2,500/mo, ideally next month." },
      {
        who: "agent" as const,
        text: "I have three matches. Can I get your name and email to send details?",
      },
      { who: "caller" as const, text: "Priya Sharma, priya@example.com." },
      {
        who: "agent" as const,
        text: "Thanks Priya — sending now. A leasing agent will follow up shortly.",
      },
    ],
  },
  {
    id: "hospital",
    title: "Hospital Management",
    description: "Triage and book appointments in any language.",
    emoji: "🏥",
    script: [
      { who: "caller" as const, text: "मुझे डॉक्टर से अपॉइंटमेंट चाहिए।" },
      { who: "agent" as const, text: "ज़रूर — कौन से विभाग के लिए और कब?" },
      { who: "caller" as const, text: "Cardiology, this Friday if possible." },
      { who: "agent" as const, text: "Dr. Mehta has 3pm open. Shall I book it?" },
      { who: "caller" as const, text: "Yes please." },
      { who: "agent" as const, text: "Booked. You'll get an SMS confirmation in a minute." },
    ],
  },
  {
    id: "ecommerce",
    title: "E-commerce Support",
    description: "Order status, returns, and product Q&A — instantly.",
    emoji: "🛍️",
    script: [
      { who: "caller" as const, text: "Where's my order #45821?" },
      { who: "agent" as const, text: "Let me check… it shipped yesterday, arriving Thursday." },
      { who: "caller" as const, text: "Can I change the delivery address?" },
      { who: "agent" as const, text: "Yes — what's the new address?" },
      { who: "caller" as const, text: "742 Evergreen Terrace." },
      { who: "agent" as const, text: "Updated. You'll get a confirmation email." },
    ],
  },
];
