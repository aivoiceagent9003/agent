import { BookOpen, UserPlus, Headphones, Languages } from "lucide-react";

const features = [
  { icon: Languages, title: "Speaks their language", desc: "English, Hindi, Telugu, Tamil, and every major Indian language." },
  { icon: BookOpen, title: "Answers from your info", desc: "Grounded in your own docs, FAQs, and pricing." },
  { icon: UserPlus, title: "Captures every lead", desc: "Name, intent, and contact — pulled straight from the call." },
  { icon: Headphones, title: "Hands off to your team", desc: "Transfers hot calls to a human the moment they matter." },
];

export function Features() {
  return (
    <section id="features" className="py-24 bg-card/30">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-3xl md:text-4xl font-bold text-center">Everything a great receptionist does — on every call</h2>
        <div className="mt-14 grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((f, i) => (
            <div key={i} className="group bg-card border border-border rounded-xl p-6 hover:border-primary/50 transition shadow-card">
              <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-gradient-primary transition">
                <f.icon className="w-5 h-5 text-primary group-hover:text-primary-foreground transition" />
              </div>
              <h3 className="mt-4 font-semibold text-lg">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Pricing() {
  const tiers = [
    { name: "Starter", price: "—", desc: "For pilots and small teams.", features: ["1 voice agent", "Knowledge base + lead capture", "Human handoff", "Email support"] },
    { name: "Growth", price: "—", desc: "Most popular for scaling.", features: ["Multiple agents", "Outbound campaigns", "WhatsApp follow-ups", "Lead exports + priority support"], featured: true },
    { name: "Enterprise", price: "Custom", desc: "For large operations.", features: ["Custom integrations", "Dedicated support", "SSO & SLA"] },
  ];
  return (
    <section id="pricing" className="py-24 mx-auto max-w-7xl px-6">
      <h2 className="text-4xl md:text-5xl font-bold text-center">Simple, usage-based pricing</h2>
      <p className="mt-3 text-muted-foreground text-center">Pricing details coming soon — book a demo for a custom quote.</p>
      <div className="mt-16 grid md:grid-cols-3 gap-6">
        {tiers.map((t) => (
          <div key={t.name} className={`rounded-2xl p-8 border ${t.featured ? "border-primary bg-gradient-to-b from-primary/10 to-transparent shadow-glow" : "border-border bg-card"}`}>
            <div className="text-sm text-muted-foreground">{t.name}</div>
            <div className="mt-2 text-4xl font-bold">{t.price}</div>
            <p className="mt-2 text-sm text-muted-foreground">{t.desc}</p>
            <ul className="mt-6 space-y-2 text-sm">
              {t.features.map((f) => (
                <li key={f} className="flex items-center gap-2"><span className="text-primary">✓</span> {f}</li>
              ))}
            </ul>
            <a href="#contact" className={`mt-8 block text-center rounded-lg px-4 py-2.5 text-sm font-medium transition ${t.featured ? "bg-gradient-primary text-primary-foreground hover:opacity-90" : "border border-border hover:bg-muted"}`}>
              Talk to sales
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
