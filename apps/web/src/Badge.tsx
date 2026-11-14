export function Badge({ state }: { state: string }) {
  return (
    <span className={`badge ${state}`}>
      <i />
      {state.replaceAll('_', ' ')}
    </span>
  );
}
