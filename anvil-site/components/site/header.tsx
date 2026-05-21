import Link from "next/link";
import { BookOpen, Github, Hammer } from "lucide-react";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { Button } from "@/components/ui/button";
import { navItems, repositoryUrl } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/92 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-3 font-semibold tracking-normal" aria-label="Anvil Registry home">
          <span className="flex size-9 items-center justify-center rounded-md bg-foreground text-background">
            <Hammer className="size-5" aria-hidden="true" />
          </span>
          <span className="text-lg">ANVIL REGISTRY</span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex" aria-label="Main navigation">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className="transition-colors hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          <Button asChild>
            <Link href="/docs/introduction">Read the docs</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={repositoryUrl}>
              <Github data-icon="inline-start" aria-hidden="true" />
              View repository
            </Link>
          </Button>
        </div>
        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <Button asChild variant="outline" size="icon" aria-label="Read the docs">
            <Link href="/docs/introduction">
              <BookOpen aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
