import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check, Copy, Github, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CodePanel } from "@/components/site/code-panel";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import {
  architectureNodes,
  codeTabs,
  decisionTimeline,
  deployCards,
  docsHighlights,
  featureGroups,
  launchCopy,
  productCards,
  repositoryUrl
} from "@/lib/site";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main>
        <HeroSection />
        <ProductSection />
        <ArchitectureSection />
        <WorkflowSection />
        <PolicySection />
        <DocsSection />
        <DeploySection />
      </main>
      <SiteFooter />
    </div>
  );
}

function HeroSection() {
  return (
    <section className="border-b">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_0.9fr] lg:items-center lg:px-8 lg:py-20">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-5">
            <h1 className="max-w-3xl text-5xl font-semibold leading-[1.02] tracking-normal text-foreground sm:text-6xl lg:text-7xl">
              Forge safer npm installs
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
              Anvil is an open source npm registry gateway and hardened Node base image that puts policy, analysis, and audit trails before dependency installs.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/docs/introduction">
                Read the docs
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={repositoryUrl}>
                <Github data-icon="inline-start" aria-hidden="true" />
                View repository
              </Link>
            </Button>
          </div>
          <div className="grid max-w-2xl gap-3 text-sm text-muted-foreground sm:grid-cols-2">
            {launchCopy.map((item) => (
              <div key={item} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 text-accent" aria-hidden="true" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="relative min-h-[360px] overflow-hidden rounded-lg border bg-muted/30 shadow-anvil">
          <Image
            src="/hero-anvil.png"
            alt="Technical illustration of an anvil over npm package blocks"
            fill
            priority
            className="object-cover"
            sizes="(min-width: 1024px) 560px, 100vw"
          />
        </div>
      </div>
    </section>
  );
}

function ProductSection() {
  return (
    <section id="product" className="border-b py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading title="Two tools, one install path" description="Use the registry gateway for enforcement and the Node base image when you need a safer local harness." />
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {productCards.map((item) => (
            <Card key={item.title} className="overflow-hidden">
              <CardHeader className="gap-4">
                <div className="flex size-11 items-center justify-center rounded-md border bg-background">
                  <item.icon className="size-5 text-accent" aria-hidden="true" />
                </div>
                <div>
                  <CardTitle>{item.title}</CardTitle>
                  <CardDescription className="mt-2 max-w-xl leading-6">{item.description}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <ul className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-2">
                  {item.points.map((point) => (
                    <li key={point} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-4 text-accent" aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-3 font-mono text-xs text-muted-foreground">
                  <span className="truncate">{item.command}</span>
                  <Copy className="size-4" aria-hidden="true" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function ArchitectureSection() {
  return (
    <section id="architecture" className="border-b py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading title="Architecture that fits the toolchain" description="Anvil sits between package managers and upstream registries, then pushes expensive work out to the analysis worker." />
        <div className="mt-8 grid gap-4 lg:grid-cols-4">
          {architectureNodes.map((node) => (
            <div key={node.label} className="rounded-lg border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-md bg-muted">
                  <node.icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="font-semibold">{node.label}</h3>
              </div>
              <Separator className="my-4" />
              <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
                {node.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkflowSection() {
  const active = codeTabs[0];

  return (
    <section className="border-b py-16">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">
        <div>
          <SectionHeading title="CLI in your workflow" description="Fast, deterministic, and scriptable enough for local review, CI, and release gates." />
          <div className="mt-6 flex flex-wrap gap-2">
            {codeTabs.map((tab) => (
              <Badge key={tab.label} variant={tab.label === active.label ? "default" : "secondary"} className="px-3 py-1">
                {tab.label}
              </Badge>
            ))}
          </div>
          <div className="mt-5">
            <CodePanel command={active.command} output={active.output} title="Anvil CLI" />
          </div>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-lg font-semibold">JSON decision output</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Decisions are useful in terminals, but they also need to be boringly machine-readable.
          </p>
          <pre className="mt-5 overflow-x-auto rounded-lg border bg-muted p-5 font-mono text-xs leading-6">
            <code>{`{
  "package": "left-pad@1.3.0",
  "decision": "allow",
  "policy": "default",
  "provenance": { "verified": true },
  "signals": [],
  "cacheIdentity": "sha512-Qw8..."
}`}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

function PolicySection() {
  return (
    <section className="border-b py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading title="Policy and analysis with receipts" description="Reviewers get the why, the evidence, and the override trail. Decorative security can stay outside." />
        <div className="mt-8 grid gap-5 lg:grid-cols-[0.9fr_1.1fr_0.8fr]">
          <div className="flex flex-col gap-4">
            {featureGroups.map((feature) => (
              <div key={feature.title} className="flex gap-4 rounded-lg border bg-card p-4 shadow-sm">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                  <feature.icon className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="font-semibold">{feature.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{feature.description}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Policy decision timeline</h3>
            <div className="mt-6 flex flex-col gap-5">
              {decisionTimeline.map((event) => (
                <div key={event.title} className="grid grid-cols-[1.75rem_1fr_auto] gap-3">
                  <span className={event.status === "block" ? "mt-1 size-3 rounded-full bg-destructive" : event.status === "review" ? "mt-1 size-3 rounded-full bg-accent" : "mt-1 size-3 rounded-full bg-foreground"} />
                  <div>
                    <p className="text-sm font-medium">{event.title}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{event.detail}</p>
                  </div>
                  <Button variant="outline" size="sm">View</Button>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">left-pad</h3>
              <Badge variant="secondary">1.3.0</Badge>
            </div>
            <dl className="mt-6 flex flex-col gap-4 text-sm">
              <Metric label="Age" value="8 years" />
              <Metric label="Downloads" value="1.2M weekly" />
              <Metric label="Integrity" value="sha512-Qw8..." />
              <Metric label="Decision" value="allow" />
            </dl>
            <div className="mt-6 rounded-lg border bg-muted/60 p-4">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <ShieldCheck className="size-5 text-accent" aria-hidden="true" />
                Decision: allow
              </div>
              <p className="mt-2 text-sm text-muted-foreground">All policy checks passed for this immutable tarball identity.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DocsSection() {
  return (
    <section className="border-b py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading title="Markdown docs that ship with the project" description="The standalone site reads docs from markdown files, so launch copy and operator docs can evolve without turning the app into a CMS." />
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {docsHighlights.map((doc) => (
            <Link key={doc.href} href={doc.href} className="rounded-lg border bg-card p-5 shadow-sm transition-colors hover:bg-muted/40">
              <doc.icon className="size-5 text-accent" aria-hidden="true" />
              <h3 className="mt-4 font-semibold">{doc.label}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Read the {doc.label.toLowerCase()} guide.</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function DeploySection() {
  return (
    <section id="deploy" className="py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading title="Deploy without ceremony" description="The docs site is standalone for Vercel. The product stack keeps Docker Compose and SST paths explicit." />
        <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {deployCards.map((card) => (
            <div key={card.title} className="rounded-lg border bg-card p-5 shadow-sm">
              <card.icon className="size-5 text-accent" aria-hidden="true" />
              <h3 className="mt-4 font-semibold">{card.title}</h3>
              <p className="mt-2 min-h-16 text-sm leading-6 text-muted-foreground">{card.description}</p>
              <pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                <code>{card.command}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-normal text-foreground">{title}</h2>
      <p className="mt-3 text-base leading-7 text-muted-foreground">{description}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b pb-3 last:border-b-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
