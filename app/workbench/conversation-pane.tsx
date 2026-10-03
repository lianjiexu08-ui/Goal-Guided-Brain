/* oxlint-disable */
// @ts-nocheck
'use client';
// Focused presentation modules receive a controller context assembled by Workbench.
/* oxlint-disable no-explicit-any, no-unused-vars */
import Markdown from 'react-markdown';
import { api, entityList, entityText } from '../workbench-api';
import {
  AssistantEditor,
  assistantIcons,
  blankAssistant,
  type Assistant,
} from '../assistant-editor';
import { TeamActivity } from './team-activity';
import { KnowledgeCollection } from './knowledge-collection';
import { RiskInbox } from './team-overview';
import { Choice } from './choice';
import {
  ExecutionInspector,
  Management,
  managementNavigation,
} from '../management';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  Circle,
  Copy,
  FileText,
  FolderOpen,
  History,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquare,
  Pencil,
  Paperclip,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Undo2,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { WorkbenchContext } from './view-context';

import { ConversationMain } from './conversation-main';
import { ConversationAside } from './conversation-aside';

export function ConversationPane({ context }: { context: WorkbenchContext }) {
  const { teamSpace, role } = context;
  return (
    <div
      className="working-grid"
      key={`workspace:${teamSpace?.id || 'none'}:${role}`}
    >
      <ConversationMain context={context} />
      <ConversationAside context={context} />
    </div>
  );
}
