'use client';

import { MenuIcon } from 'lucide-react';
import { useState } from 'react';

import { NavLinks } from '@/components/nav/nav-links';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

export function MobileNav({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="size-9 rounded-full md:hidden"
          >
            <MenuIcon className="size-4" />
          </Button>
        )}
      />

      <SheetContent side="right" className="w-full pt-2 sm:max-w-xs">
        <SheetHeader>
          <SheetTitle className="font-display text-lg">Tender</SheetTitle>
          <SheetDescription className="sr-only">Site navigation</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <NavLinks signedIn={signedIn} variant="mobile" onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
