import { useState } from "react";
import { toast } from "sonner";
import { BASE_URL } from "@/lib/api";

export function ContactForm() {
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setLoading(true);
    const fd = new FormData(form);
    const phone = String(fd.get("phone") || "").trim();
    // The existing endpoint stores name/email/company/message. Preserve the
    // optional phone in the message rather than silently losing it on the server.
    const payload = {
      name: String(fd.get("name") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      company: String(fd.get("company") || "").trim(),
      message: [String(fd.get("message") || "").trim(), phone ? `Phone: ${phone}` : ""].filter(Boolean).join("\n\n"),
    };
    try {
      const response = await fetch(`${BASE_URL}/api/public/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.success !== true) throw new Error(result.error || "Could not submit. Please try again.");
      toast.success("Thanks! We'll be in touch within one business day.");
      form.reset();
    } catch (err: any) {
      toast.error(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section id="contact" className="py-24 mx-auto max-w-3xl px-6">
      <div className="text-center">
        <h2 className="text-4xl md:text-5xl font-bold">Book a demo</h2>
        <p className="mt-3 text-muted-foreground">
          Tell us about your business — we'll show you AnswerLabs live.
        </p>
      </div>
      <form
        onSubmit={onSubmit}
        className="mt-10 bg-card border border-border rounded-2xl p-8 shadow-card grid gap-4"
      >
        <div className="grid md:grid-cols-2 gap-4">
          <Field name="name" label="Your name" required />
          <Field name="company" label="Company" required />
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <Field name="email" type="email" label="Work email" required />
          <Field name="phone" label="Phone (optional)" />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="demo-message" className="text-sm text-muted-foreground">
            What do you want to use AnswerLabs for?
          </label>
          <textarea
            id="demo-message"
            name="message"
            rows={4}
            className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          disabled={loading}
          className="mt-2 bg-gradient-primary text-primary-foreground font-medium rounded-lg px-6 py-3 shadow-glow hover:opacity-90 transition disabled:opacity-60"
        >
          {loading ? "Sending…" : "Request a demo"}
        </button>
      </form>
    </section>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={`demo-${name}`} className="text-sm text-muted-foreground">{label}</label>
      <input
        id={`demo-${name}`}
        name={name}
        type={type}
        required={required}
        className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}
