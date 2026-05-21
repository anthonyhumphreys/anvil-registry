import Link from "next/link";
import { Hammer } from "lucide-react";
import { repositoryUrl } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t bg-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-foreground text-background">
            <Hammer className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="font-semibold">ANVIL REGISTRY</p>
            <p className="text-sm text-muted-foreground">Open source dependency safety for the npm ecosystem.</p>
          </div>
        </div>
        <nav className="flex flex-wrap gap-5 text-sm text-muted-foreground" aria-label="Footer navigation">
          <Link href={repositoryUrl} className="hover:text-foreground">
            GitHub
          </Link>
          <Link href="/docs/policy" className="hover:text-foreground">
            Security
          </Link>
          <Link href="/docs/deploy" className="hover:text-foreground">
            Deploy
          </Link>
          <Link href="/docs/community" className="hover:text-foreground">
            Launch notes
          </Link>
        </nav>
      </div>
    </footer>
  );
}
