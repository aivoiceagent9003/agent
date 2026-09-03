import { createFileRoute } from "@tanstack/react-router";
import { LegalPage, Section } from "@/components/site/LegalPage";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of Service — AnswerLabs" }] }),
  component: Terms,
});

function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="22 August 2026">
      <Section heading="The service">
        <p>
          AnswerLabs provides AI voice agents that answer your inbound calls and, where you configure
          it, place outbound calls on your behalf. You configure what the agent knows and how it
          behaves; we run it.
        </p>
      </Section>

      <Section heading="Your responsibilities when calling people">
        <p>
          This is the part that matters most, because outbound calling is where the legal risk sits
          and it sits with you, not with us.
        </p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            You must have a lawful basis for calling every number you upload. Consent that you can
            evidence, or an existing relationship that permits contact.
          </li>
          <li>
            You must comply with TRAI&apos;s commercial communication rules, including registration
            requirements and calling-hour restrictions where they apply to you.
          </li>
          <li>
            You must not upload numbers scraped, purchased, or otherwise obtained without a basis to
            contact them.
          </li>
          <li>
            You are the data fiduciary for everyone you call. We process their data on your
            instructions.
          </li>
        </ul>
        <p>
          We enforce some of this in the product — working-hour windows, suppression lists, and an
          in-call opt-out the agent always honours — but those are safety nets, not a transfer of
          responsibility.
        </p>
      </Section>

      <Section heading="Things we do regardless of your settings">
        <p>Two behaviours are not configurable, because they belong to the person on the call:</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            If someone asks not to be called again, the agent removes them immediately and ends the
            call. You cannot switch this off, and the agent will not try to talk them out of it.
          </li>
          <li>
            If someone asks whether they are speaking to a machine, the agent tells them the truth.
          </li>
        </ul>
      </Section>

      <Section heading="Call recording">
        <p>
          Recording is off by default. If you enable it, the agent discloses it at the start of
          every call, and we keep a record that the disclosure was played. You are responsible for
          having a lawful basis to record, and for any additional notice your own regulator
          requires.
        </p>
      </Section>

      <Section heading="Availability">
        <p>
          We aim to keep the service available but do not currently offer a contractual uptime
          guarantee. The service depends on third parties — a telephony carrier and a speech model
          provider — and an outage at either can interrupt calls.
        </p>
        <p className="text-sm text-muted-foreground">
          If you intend to offer an SLA, it has to be written to account for those dependencies,
          including that the underlying speech model is currently a preview release without an
          availability guarantee.
        </p>
      </Section>

      <Section heading="Fees">
        <p className="text-sm text-muted-foreground">
          Pricing terms, billing cycle, overage handling, taxes, and refund policy go here once
          plans are finalised. Do not accept payment before this section is complete and reviewed.
        </p>
      </Section>

      <Section heading="Ending the agreement">
        <p>
          You can close your account at any time. On closure we delete your agent configuration,
          knowledge base, call records, and recordings. Tell us before you close if you want an
          export.
        </p>
        <p>
          We may suspend an account that is using the service to call people unlawfully. In practice
          we will contact you first unless the harm is ongoing.
        </p>
      </Section>
    </LegalPage>
  );
}
