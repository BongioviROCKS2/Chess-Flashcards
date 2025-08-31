import { useNavigate } from 'react-router-dom';
import { useBackKeybind } from '../hooks/useBackKeybind';

export default function StatsPage() {
  const navigate = useNavigate();
  const onBack = () => navigate(-1);
  useBackKeybind(onBack, true);

  return (
    <div className="container">
      <div className="card grid">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Stats</h2>
          <button className="button secondary" onClick={onBack}>Back</button>
        </div>

        <div className="grid" style={{ padding: 8 }}>
          <div className="sub">User review statistics will appear here. (Coming soon)</div>
        </div>
      </div>
    </div>
  );
}
