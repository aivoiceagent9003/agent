import { createFileRoute } from "@tanstack/react-router";
import { SiteNav, SiteFooter } from "@/components/site/SiteChrome";
import { OrbHero } from "@/components/site/OrbHero";
import { HowItWorks } from "@/components/site/HeroSections";
import { Features, Pricing } from "@/components/site/Features";
import { IndustryDemos } from "@/components/site/IndustryDemos";
import { ContactForm } from "@/components/site/ContactForm";
import { Reveal } from "@/components/Motion";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Vocera — AI Voice Agents That Never Miss a Call" },
      { name: "description", content: "Multilingual AI voice agents that answer, qualify, and hand off calls — built for modern businesses." },
      { property: "og:title", content: "Vocera — AI Voice Agents" },
      { property: "og:description", content: "Answer every call. Capture every lead. In 30+ languages." },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteNav />
      <main className="flex-1">
        <OrbHero />
        <Reveal><Features /></Reveal>
        <Reveal><HowItWorks /></Reveal>
        <Reveal><IndustryDemos /></Reveal>
        <Reveal><Pricing /></Reveal>
        <Reveal><ContactForm /></Reveal>
      </main>
      <SiteFooter />
    </div>
  );
}
