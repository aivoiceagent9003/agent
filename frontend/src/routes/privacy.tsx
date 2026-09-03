import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, Section } from "@/components/site/LegalPage";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy Policy — AnswerLabs" }] }),
  component: Privacy,
});

function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="22 August 2026">
      <Section heading="Who this covers">
        <p>
          AnswerLabs provides AI voice agents to businesses. Two different groups of people appear in
          this policy, and the law treats them differently:
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            <strong>Our customers</strong> — the businesses that sign up. We are the data fiduciary
            for their account data.
          </li>
          <li>
            <strong>Callers</strong> — people who phone one of our customers, or are phoned by them.
            Here the business is the data fiduciary and AnswerLabs is a data processor acting on their
            instructions.
          </li>
        </ul>
      </Section>

      <Section heading="What we collect on a call">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>The caller&apos;s phone number and the number they dialled.</li>
          <li>
            A transcript of the conversation, and any details the caller volunteers — typically
            their name, and whatever they were asking about.
          </li>
          <li>
            <strong>An audio recording, only if that business has switched recording on.</strong>{" "}
            Recording is off by default. When it is on, the agent says so at the start of the call,
            in the caller&apos;s language, and we store the fact that the notice was played against
            that specific call.
          </li>
          <li>
            Technical measurements — call duration, response latency, error counts — used to keep
            the service working.
          </li>
        </ul>
      </Section>

      <Section heading="How long we keep it">
        <p>
          Call recordings, transcripts, and caller phone numbers are deleted after the retention
          window set by the business, which defaults to <strong>90 days</strong>. After that the
          recording is deleted from storage, the transcript is erased, and the phone number is
          replaced with a redacted placeholder.
        </p>
        <p>
          The call record itself is kept — duration, outcome, timestamp — because the business needs
          it for their own history and we need it for billing. It no longer identifies the caller.
        </p>
      </Section>

      <Section heading="Who we share it with">
        <p>
          We do not sell personal data. We use the following sub-processors, each of which receives
          only what it needs to do its job:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Provider</th>
                <th className="text-left px-4 py-2 font-medium">What it handles</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-4 py-2 font-medium">Google (Gemini)</td>
                <td className="px-4 py-2">
                  Live call audio, to understand and respond in real time
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">Vobiz</td>
                <td className="px-4 py-2">Telephony — connecting and carrying the call</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">Supabase</td>
                <td className="px-4 py-2">Database and storage for transcripts and recordings</td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">OpenAI</td>
                <td className="px-4 py-2">
                  Text embeddings for the business&apos;s own knowledge base
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2 font-medium">Meta (WhatsApp)</td>
                <td className="px-4 py-2">
                  Sending a brochure or confirmation, only when the caller asks for one
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section heading="Your rights">
        <p>
          Under the Digital Personal Data Protection Act 2023 you can ask what we hold about you,
          ask for it to be corrected, and ask for it to be erased.
        </p>
        <p>
          <strong>To be erased:</strong> email us from any address with the phone number concerned.
          We remove your recordings, transcripts, lead records, and contact entries across every
          business on the platform — not just the one that called you — and keep a dated record that
          we did, so you can check later. That record stores a one-way hash of your number rather
          than the number itself.
        </p>
        <p>
          <strong>To stop being called:</strong> say so on the call. Tell the agent not to call you
          again and it will remove you immediately and end the call. You can also email us. We do
          not ask you to justify it.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Privacy questions and erasure requests:{" "}
          <a className="text-primary hover:underline" href="mailto:privacy@answerlabs.in">
            privacy@answerlabs.in
          </a>
          .
        </p>
        <p className="text-sm text-muted-foreground">
          Replace with your real contact address and registered business details before publishing.
        </p>
      </Section>
    </LegalPage>
  );
}
