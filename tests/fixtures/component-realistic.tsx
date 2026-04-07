import React, { useState, useCallback, useMemo } from 'react';

interface Task {
  id: string;
  status: string;
  title: string;
}

// Realistic React component with inner-scope symbols that nexus_find must catch
export default function KanbanBoard({ tasks }: { tasks: Task[] }) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Arrow function assigned to const — the pattern nexus_find missed
  const getTasksByStatus = (status: string) => {
    return tasks.filter(t => t.status === status);
  };

  // useCallback-wrapped handler
  const handleDragStart = useCallback((task: Task) => {
    setActiveTask(task);
    setIsDragging(true);
  }, []);

  // useCallback-wrapped handler
  const handleDragEnd = useCallback(() => {
    setActiveTask(null);
    setIsDragging(false);
  }, []);

  // useCallback-wrapped handler
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  // useMemo-wrapped derived state
  const taskCounts = useMemo(() => {
    return {
      todo: getTasksByStatus('todo').length,
      doing: getTasksByStatus('doing').length,
      done: getTasksByStatus('done').length,
    };
  }, [tasks]);

  // Nested function declaration inside component body
  function renderColumn(status: string) {
    const columnTasks = getTasksByStatus(status);
    return (
      <div onDragOver={handleDragOver}>
        {columnTasks.map(t => <div key={t.id}>{t.title}</div>)}
      </div>
    );
  }

  return (
    <div>
      {isDragging && <div>Dragging: {activeTask?.title}</div>}
      {renderColumn('todo')}
      {renderColumn('doing')}
      {renderColumn('done')}
      <div>Counts: {taskCounts.todo}</div>
    </div>
  );
}
