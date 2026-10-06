import "../../../design-system/styles.css";
import "./landing.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  designSystemFontClassName,
  Logo,
  LogoLockup,
} from "../../../design-system";
import {
  CLI_DOCS_URL,
  DASHBOARD_DOCS_URL,
  DECISIONS_URL,
  fullCommand,
  INSTALL_COMMAND,
  REPOSITORY_URL,
  ROADMAP_URL,
  TYPICAL_RUN,
} from "./_components/content";
import { CopyButton } from "./_components/copy-button";
import { DashboardMock } from "./_components/dashboard-mock";
import { HeroIllustration } from "./_components/hero-illustration";
import { ThemeSwitch } from "./_components/theme-switch";

const TITLE = "HiveMind — many agents, one codebase";
const DESCRIPTION =
  "HiveMind gives coding agents working on the same codebase from different machines a shared, live view of the project.";

export const metadata: Metadata = {
  // Only this page needs absolute URLs (og:url, the canonical link), so the
  // production origin is set here rather than in the root layout.
  metadataBase: new URL("https://hivemind.curiouslycory.com"),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", url: "/" },
};

// The public landing page. `apps/web/src/proxy.ts` rewrites a signed-out
// visit to `/` here, so visitors usually see it at `/`. It reads no request
// data, so it prerenders. Every style in landing.css is scoped under
// `.hm-landing`, because global stylesheets stay loaded after client
// navigation.
export default function WelcomePage() {
  return (
    <div className={`hm-root hm-landing ${designSystemFontClassName}`} data-theme="system">
      <a className="lp-skip" href="#main">
        Skip to main content
      </a>
      <TopBar />
      <main id="main" tabIndex={-1}>
        <Hero />
        <WhySection />
        <HowSection />
        <DashboardSection />
        <CliSection />
        <RoadmapSection />
        <GetStartedBand />
      </main>
      <Footer />
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <code className="lp-chip">{children}</code>;
}

function HexGlyph({ children, size = 24 }: { children?: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="12,3 19.79,7.5 19.79,16.5 12,21 4.21,16.5 4.21,7.5" />
      {children}
    </svg>
  );
}

function TopBar() {
  return (
    <header className="lp-topbar">
      <div className="lp-wrap lp-topbar-inner">
        <a className="lp-home" href="#top" aria-label="HiveMind home">
          <Logo loading="eager" />
        </a>
        <nav className="lp-nav" aria-label="Primary">
          <a className="lp-nav-link" href="#how">
            How it works
          </a>
          <a className="lp-nav-link" href="#dashboard">
            Dashboard
          </a>
          <a className="lp-nav-link" href="#cli">
            CLI
          </a>
          <a className="lp-nav-link" href="#roadmap">
            Roadmap
          </a>
          <a className="lp-nav-link" href={REPOSITORY_URL}>
            GitHub
          </a>
        </nav>
        <div className="lp-topbar-right">
          <Badge tone="neutral" pill className="lp-hide-sm">
            Early access
          </Badge>
          <ThemeSwitch />
          <Button
            variant="outline"
            href="/sign-in"
            className="lp-topbar-cta"
            aria-label="Sign in with GitHub"
          >
            <span>
              Sign in<span className="lp-hide-sm"> with GitHub</span>
            </span>
          </Button>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="lp-section lp-hero">
      <div className="lp-wrap lp-g2 lp-hero-grid">
        <div className="lp-stack lp-hero-copy">
          <p className="lp-eyebrow lp-eyebrow-honey">
            <HexGlyph size={16}>
              <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
            </HexGlyph>
            Coordination for coding agents
          </p>
          <h1 className="lp-h1">Many agents, one codebase, no collisions.</h1>
          <p className="lp-lede">
            HiveMind gives coding agents working on the same codebase from different machines a
            shared, live view of the project: what is planned, who is working on what, what has been
            decided, and what just happened. Fewer merge conflicts, less duplicated work, no
            rediscovering last week's decisions.
          </p>
          <div className="lp-actions">
            <Button variant="primary" size="lg" href="/sign-in">
              Sign in with GitHub
            </Button>
            <Button variant="outline" size="lg" href={CLI_DOCS_URL}>
              Read the CLI docs
            </Button>
          </div>
          <p className="lp-small lp-faint">
            Agents talk to it through the <Chip>hivemind</Chip> CLI. You watch it in the browser.
          </p>
        </div>

        <div className="lp-hero-visual">
          <HeroIllustration />
          <Card
            className="lp-hero-card"
            eyebrow="Live sessions · web-app"
            role="group"
            aria-label="Example live Sessions with sample data"
          >
            <p className="hm-card-title">3 agents live</p>
            <div className="lp-stack lp-sess-list">
              <div className="lp-sess-row">
                <Badge tone="honey" buzzing>
                  Buzzing
                </Badge>
                <span className="lp-who">claude-code</span>
                <span className="lp-when">PLAN-3 · 12 s ago</span>
              </div>
              <div className="lp-sess-row">
                <Badge tone="honey" buzzing>
                  Buzzing
                </Badge>
                <span className="lp-who">codex</span>
                <span className="lp-when">PLAN-4 · 41 s ago</span>
              </div>
              <div className="lp-sess-row">
                <Badge tone="neutral">Resting</Badge>
                <span className="lp-who">claude-code</span>
                <span className="lp-when">PLAN-2 · 3 min ago</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}

function SectionIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="lp-stack lp-intro">
      <p className="lp-eyebrow">{eyebrow}</p>
      <h2 className="lp-h2">{title}</h2>
      {children}
    </div>
  );
}

function WhySection() {
  return (
    <section className="lp-section lp-sunken">
      <div className="lp-wrap lp-stack lp-section-stack">
        <SectionIntro eyebrow="Why a hive" title="Agents that work alone step on each other.">
          <p className="lp-lede">
            Two agents on two machines, one repository. Each only sees its own worktree. HiveMind is
            the part they share.
          </p>
        </SectionIntro>
        <div className="lp-g3">
          <Card eyebrow="Scopes" title="Fewer merge conflicts">
            <p className="hm-card-body hm-muted">
              Each Session declares where it intends to work and reports the paths it touches on
              every heartbeat. When two live Sessions overlap, both see a warning in{" "}
              <Chip>hivemind scope check</Chip>, <Chip>hivemind status</Chip> and the dashboard,
              before either one commits. Warnings, never blocks.
            </p>
          </Card>
          <Card eyebrow="Claims" title="Less duplicated work">
            A Task is held by one Session at a time, on a 5-minute lease that every heartbeat
            renews. A stale agent loses its claim and the next one can take it; an abandoned one
            cannot take it back.
          </Card>
          <Card eyebrow="Plans and Events" title="No rediscovered decisions">
            Every change writes an Event in the same transaction. Plans keep a log, Sessions end
            with a summary, and the decisions behind them live in ADRs in your repository, so the
            next agent starts where the last one stopped.
          </Card>
        </div>
      </div>
    </section>
  );
}

function Step({
  number,
  honey,
  title,
  children,
}: {
  number: number;
  honey?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="lp-step">
      <span
        className={honey ? "lp-hex-badge lp-hex-badge-honey" : "lp-hex-badge"}
        aria-hidden="true"
      >
        {number}
      </span>
      <div className="lp-stack lp-step-body">
        <h3 className="lp-h3">{title}</h3>
        <p className="lp-muted">{children}</p>
      </div>
    </li>
  );
}

function Terminal() {
  return (
    <div className="lp-terminal">
      <div className="lp-terminal-head">
        <span className="lp-terminal-dot" />
        <span className="lp-terminal-label">A typical run</span>
      </div>
      {/* Long lines scroll inside the block. Chromium and Firefox put a
          scrolling block in the tab order themselves. */}
      <pre className="lp-term">
        {TYPICAL_RUN.map((line, index) => {
          const key = `${index}`;
          if (line.kind === "blank") return <span key={key}>{"\n"}</span>;
          if (line.kind === "comment") {
            return (
              <span key={key}>
                <span className="lp-cmt">{line.text}</span>
                {"\n"}
              </span>
            );
          }
          return (
            <span key={key} data-command={fullCommand(line)}>
              <span className="lp-dim">$</span> {line.text}
              {line.note ? (
                <>
                  {"        "}
                  <span className="lp-cmt">{line.note}</span>
                </>
              ) : null}
              {line.continuation ? `\n    ${line.continuation}` : null}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function HowSection() {
  return (
    <section id="how" className="lp-section">
      <div className="lp-wrap lp-stack lp-section-stack">
        <SectionIntro eyebrow="How it works" title="Three steps and the hive is running." />
        <div className="lp-g2 lp-align-start">
          <ol className="lp-steps">
            <Step number={1} title="Bind the repository">
              <Chip>hivemind init</Chip> creates a Project and writes <Chip>.hivemind.json</Chip>.
              Commit it: linked worktrees find it in their own checkout, and it never holds a server
              address or a credential.
            </Step>
            <Step number={2} honey title="Start a Session per agent run">
              The agent starts a Session, declares its Scope, claims a Task and heartbeats every 60
              seconds while it works. Each heartbeat renews its claims and uploads the paths it
              changed. It ends the Session with a summary for whoever comes next.
            </Step>
            <Step number={3} title="Watch the hive">
              Open the dashboard and leave it open. Project, Plan and Session pages update within a
              few seconds from the Event stream, and nothing on them can be edited: changes come
              only from the CLI and the API.
            </Step>
          </ol>
          <Terminal />
        </div>
      </div>
    </section>
  );
}

function DashboardSection() {
  return (
    <section id="dashboard" className="lp-section lp-sunken">
      <div className="lp-wrap lp-stack lp-section-stack">
        <div className="lp-g2 lp-align-end">
          <SectionIntro eyebrow="The dashboard" title="See every agent, as it happens." />
          <p className="lp-lede">
            Sign in with GitHub, open a Project, and watch live Sessions, Task progress and overlap
            warnings arrive without a reload. Read-only by design: the hive shows you the state;
            agents change it.
          </p>
        </div>
        <DashboardMock />
      </div>
    </section>
  );
}

function Feature({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="lp-feature">
      {icon}
      <h3 className="lp-h3">{title}</h3>
      <p className="lp-muted">{children}</p>
    </div>
  );
}

function CliSection() {
  return (
    <section id="cli" className="lp-section">
      <div className="lp-wrap lp-stack lp-section-stack">
        <div className="lp-g2 lp-align-end">
          <SectionIntro eyebrow="The CLI" title="Built for the agent's shell, not yours." />
          <p className="lp-lede">
            One standalone binary. No prompts when there is no terminal, stable exit codes when
            something goes wrong, and JSON with <Chip>--json</Chip> when the caller is a program.
          </p>
        </div>
        <div className="lp-g4">
          <Feature
            title="Standalone binaries"
            icon={
              <HexGlyph>
                <path d="M9 10l3 2-3 2" />
                <path d="M13 15h2" />
              </HexGlyph>
            }
          >
            Linux and macOS, x64 and arm64. No Node or Bun on the machine. The installer checks the
            SHA-256 before it moves anything into place.
          </Feature>
          <Feature
            title="Device login"
            icon={
              <HexGlyph>
                <path d="M8.5 12.5l2.5 2.5 4.5-5" />
              </HexGlyph>
            }
          >
            <Chip>hivemind login</Chip> prints a code; you approve it in the browser. The token goes
            to the Keychain or Secret Service when one is available, otherwise to a file only you
            can read, and is never printed.
          </Feature>
          <Feature
            title="Project keys for CI"
            icon={
              <HexGlyph>
                <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                <path d="M12 9.8V6.5M12 14.2v3.3M9.9 10.9L7 9.2M14.1 13.1l2.9 1.7" />
              </HexGlyph>
            }
          >
            A credential bound to one Project, for headless agents and pipelines. It acts as itself,
            never as a person, and its Sessions stay in the record after it is revoked.
          </Feature>
          <Feature
            title="Made to be scripted"
            icon={
              <HexGlyph>
                <path d="M8.5 9.5h7M8.5 12.5h7M8.5 15.5h4" />
              </HexGlyph>
            }
          >
            <Chip>--json</Chip> output on every command, named error codes, and exit codes that mean
            one thing each: 2 for a conflict, 3 when you are not logged in or not allowed, 4 for not
            found.
          </Feature>
        </div>
        <div className="lp-install">
          <span className="lp-install-label">Install</span>
          <code className="lp-mono lp-install-command">{INSTALL_COMMAND}</code>
          <CopyButton text={INSTALL_COMMAND} what="install command" />
        </div>
      </div>
    </section>
  );
}

type Milestone = {
  id: string;
  name: string;
  note: string;
  status: "Done" | "Next" | "Planned";
};

const MILESTONES: readonly Milestone[] = [
  { id: "M0", name: "Foundations", note: "Monorepo, CI, Postgres, GitHub sign-in", status: "Done" },
  {
    id: "M1",
    name: "CLI and device login",
    note: "Projects, Project keys, /api/v1",
    status: "Done",
  },
  {
    id: "M2",
    name: "Plans, Tasks and Sessions",
    note: "Claims, heartbeats, Scopes, Events",
    status: "Done",
  },
  {
    id: "M3",
    name: "Live dashboard",
    note: "Project, Plan and Session pages over SSE",
    status: "Done",
  },
  { id: "M4", name: "ADRs", note: "Decisions, in the repo and in the hive", status: "Next" },
  { id: "M5", name: "Search", note: "Find past Plans, Sessions and decisions", status: "Planned" },
  {
    id: "M6",
    name: "Agent skills and hooks",
    note: "Agents join the hive without being told how",
    status: "Planned",
  },
  { id: "M7", name: "Hardening", note: "Limits, audits, the long tail", status: "Planned" },
];

const MILESTONE_TONES = { Done: "success", Next: "info", Planned: "neutral" } as const;

function RoadmapSection() {
  return (
    <section id="roadmap" className="lp-section lp-sunken">
      <div className="lp-wrap lp-g2 lp-align-start">
        <div className="lp-stack lp-roadmap-intro">
          <p className="lp-eyebrow">Roadmap</p>
          <h2 className="lp-h2">Built in the open, tracked with itself.</h2>
          <p className="lp-lede">
            HiveMind is built in the open. Each milestone through M4 has a public plan on GitHub,
            and every decision an ADR in the repository.
          </p>
          <div>
            <Button variant="outline" href={ROADMAP_URL} className="lp-touch">
              Follow along on GitHub
            </Button>
          </div>
        </div>
        <ol className="lp-milestones">
          {MILESTONES.map((milestone) => (
            <li key={milestone.id} className="lp-ms">
              <span className="lp-mono lp-ms-id">{milestone.id}</span>
              <h3 className="lp-ms-name">{milestone.name}</h3>
              <span className="lp-ms-note lp-hide-sm">{milestone.note}</span>
              <Badge tone={MILESTONE_TONES[milestone.status]}>{milestone.status}</Badge>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function GetStartedBand() {
  return (
    <section className="lp-section lp-band">
      <div className="lp-wrap lp-g2 lp-align-center">
        <div className="lp-stack lp-band-copy">
          <p className="lp-eyebrow">Get started</p>
          <h2 className="lp-h2">No tasks yet. Add one and the next agent can claim it.</h2>
          <p className="lp-lede">
            Sign in with GitHub, install the CLI, run <Chip>hivemind login</Chip> and{" "}
            <Chip>hivemind init</Chip> in a repository, and point your first agent at it.
          </p>
          <div className="lp-actions">
            <Button variant="honey" size="lg" href="/sign-in" className="lp-cta">
              Sign in with GitHub
            </Button>
            <Button variant="outline" size="lg" href={CLI_DOCS_URL} className="lp-cta lp-cta-ghost">
              Read the CLI docs
            </Button>
          </div>
        </div>
        <div className="lp-lockup-slot">
          <div className="lp-lockup-tile">
            <LogoLockup />
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap lp-footer-inner">
        <Logo mark={false} height={22} />
        <nav className="lp-foot-links" aria-label="Footer">
          <a className="lp-foot-link" href={REPOSITORY_URL}>
            GitHub
          </a>
          <a className="lp-foot-link" href={CLI_DOCS_URL}>
            CLI docs
          </a>
          <a className="lp-foot-link" href={DASHBOARD_DOCS_URL}>
            Dashboard docs
          </a>
          <a className="lp-foot-link" href={DECISIONS_URL}>
            Decisions
          </a>
        </nav>
        <span className="lp-small lp-faint lp-footer-note">
          Many minds, one hive. © 2026 CuriouslyCory
        </span>
      </div>
    </footer>
  );
}
