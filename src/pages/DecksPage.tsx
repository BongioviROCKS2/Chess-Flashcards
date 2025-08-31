import DeckTree from '../components/DeckTree';

export default function DecksPage() {
  return (
    <div className="container">
      <div className="card grid">
        <div>
          <h2 style={{ margin: 0 }}>Choose a deck</h2>
        </div>
        <DeckTree rootId="openings" />
      </div>
    </div>
  );
}
