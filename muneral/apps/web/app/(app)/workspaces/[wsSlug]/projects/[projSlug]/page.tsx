'use client';

import { useParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KanbanBoard } from '@/components/kanban/KanbanBoard';
import { useProject } from '@/lib/api/projects';
import { useTasks } from '@/lib/api/tasks';
import { useProjectStore } from '@/store/project';
import { useEffect } from 'react';
import { Badge } from '@/components/ui/badge';

export default function ProjectPage() {
  const { wsSlug, projSlug } = useParams<{ wsSlug: string; projSlug: string }>();
  const { data: project, isLoading } = useProject(wsSlug, projSlug);
  const { setCurrentProject } = useProjectStore();
  const { data: tasksResult } = useTasks(project?.id ?? '', {});
  const allTasks = tasksResult?.data ?? [];

  useEffect(() => {
    if (project) {
      setCurrentProject(project.slug, project.id);
    }
  }, [project, setCurrentProject]);

  if (isLoading || !project) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">Loading project...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <Badge variant={project.status === 'active' ? 'success' : 'secondary'}>
          {project.status}
        </Badge>
      </div>

      <Tabs defaultValue="kanban">
        <TabsList>
          <TabsTrigger value="kanban">Kanban</TabsTrigger>
          <TabsTrigger value="backlog">Backlog ({allTasks.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="kanban" className="mt-4">
          <KanbanBoard
            projectId={project.id}
            wsSlug={wsSlug}
            projSlug={projSlug}
          />
        </TabsContent>

        <TabsContent value="backlog" className="mt-4">
          <div className="rounded-lg border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">Title</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Priority</th>
                  <th className="px-4 py-2 text-left font-medium">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {allTasks.map((task) => (
                  <tr key={task.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-2.5">
                      <a
                        href={`/workspaces/${wsSlug}/projects/${projSlug}/tasks/${task.id}`}
                        className="font-medium hover:underline"
                      >
                        {task.title}
                      </a>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className="text-xs">
                        {task.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className="text-xs">
                        {task.priority}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {task.dueDate
                        ? new Date(task.dueDate).toLocaleDateString()
                        : '—'}
                    </td>
                  </tr>
                ))}
                {allTasks.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      No tasks yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
