import { ReactFlow, Background, Controls, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Task } from '../../../packages/shared/index.ts';
import { Badge } from './Badge.tsx';
export default function DependencyGraph({
  tasks,
  select,
}: {
  tasks: Task[];
  select: (t: Task) => void;
}) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depths = new Map<string, number>();
  function depth(t: Task): number {
    if (depths.has(t.id)) return depths.get(t.id)!;
    const d = t.dependencies.length
      ? Math.max(
          ...t.dependencies.map((id) => {
            const dep = byId.get(id);
            return dep ? depth(dep) + 1 : 0;
          }),
        )
      : 0;
    depths.set(t.id, d);
    return d;
  }
  const lanes = new Map<number, number>();
  const nodes = tasks.map((t) => {
    const d = depth(t),
      lane = lanes.get(d) ?? 0;
    lanes.set(d, lane + 1);
    return {
      id: t.id,
      position: { x: lane * 260, y: d * 150 },
      data: {
        label: (
          <div className="graph-label">
            <small>{t.provider.toUpperCase()}</small>
            <b>{t.title}</b>
            <Badge state={t.state} />
          </div>
        ),
      },
      style: { width: 220 },
    };
  });
  const edges = tasks.flatMap((t) =>
    t.dependencies.map((dep) => ({
      id: `${dep}-${t.id}`,
      source: dep,
      target: t.id,
      animated: t.state === 'running',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#546c85' },
    })),
  );
  return (
    <div className="graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        colorMode="dark"
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, n) => {
          const t = tasks.find((t) => t.id === n.id);
          if (t) select(t);
        }}
      >
        <Background color="#303945" gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
