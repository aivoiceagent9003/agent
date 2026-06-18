import { useState } from "react";
import { toast } from "sonner";

export function ContactForm() {
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const payload = Object.fromEntries(fd.entries());
    try {
      // Hook up to your real public endpoint when ready.
      // await apiFetch("/api/public/contact", { method: "POST", body: JSON.stringify(payload) });
      await new Promise((r) => setTimeout(r, 700));
      console.log("Contact form submitted:", payload);
      toast.success("Thanks! We'll be in touch within one business day.");
      (e.target as HTMLFormElement).reset();
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
        <p className="mt-3 text-muted-foreground">Tell us about your business — we'll show you Vocera live.</p>
      </div>
      <form onSubmit={onSubmit} className="mt-10 bg-card border border-border rounded-2xl p-8 shadow-card grid gap-4">
        <div className="grid md:grid-cols-2 gap-4">
          <Field name="name" label="Your name" required />
          <Field name="company" label="Company" required />
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <Field name="email" type="email" label="Work email" required />
          <Field name="phone" label="Phone (optional)" />
        </div>
        <div className="grid gap-1.5">
          <label className="text-sm text-muted-foreground">What do you want to use Vocera for?</label>
          <textarea name="message" rows={4} className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <button disabled={loading} className="mt-2 bg-gradient-primary text-primary-foreground font-medium rounded-lg px-6 py-3 shadow-glow hover:opacity-90 transition disabled:opacity-60">
          {loading ? "Sending…" : "Request a demo"}
        </button>
      </form>
    </section>
  );
}

function Field({ label, name, type = "text", required }: { label: string; name: string; type?: string; required?: boolean }) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm text-muted-foreground">{label}</label>
      <input
        name={name}
        type={type}
        required={required}
        className="bg-input border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}
