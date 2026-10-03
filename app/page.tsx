'use client';
import { AuthenticationGate } from './management';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Workbench } from './workbench/workbench';
export default function Home() {
  return (
    <AuthenticationGate>
      <SidebarProvider
        style={{ '--sidebar-width': '244px' } as React.CSSProperties}
      >
        <Workbench />
      </SidebarProvider>
    </AuthenticationGate>
  );
}
