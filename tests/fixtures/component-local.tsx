import React from 'react';

export const KanbanBoard = () => {
  const activeTask = null;

  const handleDragStart = () => {
    return activeTask;
  };

  function handleDragEnd() {
    return handleDragStart();
  }

  return <div onClick={handleDragEnd}>{activeTask}</div>;
};
