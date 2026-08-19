import { useEffect, useRef, useState } from "react";
import { industryDemos } from "@/lib/mock-data";
import { PhoneCall } from "lucide-react";

export function IndustryDemos() {
  const [active, setActive] = useState(industryDemos[0].id);
  const demo = industryDemos.find((d) => d.id === active)!;
  return (
    <section id="demos" className="py-24 bg-card/30">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-4xl md:text-5xl font-bold text-center">Hear it in action</h2>
        <p className="mt-3 text-muted-foreground text-center max-w-xl mx-auto">
          Tap an industry to play a sample conversation.
        </p>

        <div className="mt-12 grid md:grid-cols-3 gap-3">
          {industryDemos.map((d) => (
            <button
              key={d.id}
              onClick={() => setActive(d.id)}
              className={`text-left rounded-xl border p-5 transition ${
                active === d.id
                  ? "border-primary bg-gradient-to-br from-primary/15 to-transparent shadow-glow"
                  : "border-border bg-card hover:border-primary/50"
              }`}
            >
              <div className="text-3xl">{d.emoji}</div>
              <div className="mt-3 font-semibold">{d.title}</div>
              <div className="text-sm text-muted-foreground mt-1">{d.description}</div>
            </button>
          ))}
        </div>

        <div className="mt-10 max-w-2xl mx-auto">
          <ConversationPlayer key={demo.id} script={demo.script} />
        </div>
      </div>
    </section>
  );
}

function ConversationPlayer({ script }: { script: { who: "caller" | "agent"; text: string }[] }) {
  const [shown, setShown] = useState<number[]>([]);
  const [typing, setTyping] = useState<"caller" | "agent" | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    setShown([]);
    setTyping(null);
    timers.current.forEach(clearTimeout);
    timers.current = [];

    let delay = 400;
    script.forEach((line, i) => {
      timers.current.push(setTimeout(() => setTyping(line.who), delay));
      delay += 900;
      timers.current.push(
        setTimeout(() => {
          setShown((s) => [...s, i]);
          setTyping(null);
        }, delay),
      );
      delay += 600;
    });
    return () => timers.current.forEach(clearTimeout);
  }, [script]);

  return (
    <div className="bg-card border border-border rounded-2xl p-6 shadow-card">
      <div className="flex items-center gap-3 pb-4 border-b border-border">
        <div className="w-10 h-10 rounded-full bg-gradient-primary flex items-center justify-center">
          <PhoneCall className="w-4 h-4 text-primary-foreground" />
        </div>
        <div>
          <div className="text-sm font-medium">Live demo call</div>
          <div className="text-xs text-muted-foreground">Sample conversation</div>
        </div>
        <span className="ml-auto text-xs text-success">● Connected</span>
      </div>
      <div className="mt-4 space-y-3 min-h-[280px]">
        {script.map((line, i) =>
          shown.includes(i) ? (
            <div
              key={i}
              className={`flex ${line.who === "agent" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                  line.who === "agent"
                    ? "bg-gradient-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted rounded-bl-sm"
                }`}
              >
                {line.text}
              </div>
            </div>
          ) : null,
        )}
        {typing && (
          <div className={`flex ${typing === "agent" ? "justify-end" : "justify-start"}`}>
            <div
              className={`rounded-2xl px-4 py-3 ${typing === "agent" ? "bg-gradient-primary" : "bg-muted"}`}
            >
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce" />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce"
                  style={{ animationDelay: "0.15s" }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce"
                  style={{ animationDelay: "0.3s" }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
