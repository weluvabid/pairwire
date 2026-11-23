export function Welcome({ onCreate }: { onCreate(): void }) {
  const steps = [
    {
      number: '01',
      icon: '⌁',
      title: 'Pair manually',
      description: 'Exchange a small connection note with someone you know.',
    },
    {
      number: '02',
      icon: '↔',
      title: 'Connect directly',
      description: 'Your browsers talk to each other over a WebRTC data channel.',
    },
    {
      number: '03',
      icon: '⌁',
      title: 'Keep the thread',
      description: 'Conversation history and pending messages are saved locally.',
    },
  ];
  return (
    <section class="welcome-panel">
      <div class="welcome-eyebrow">
        <span class="eyebrow-line" /> NO ACCOUNTS. NO CHAT SERVER.
      </div>
      <h2>
        Good conversations
        <br />
        take the <em>direct route.</em>
      </h2>
      <p class="welcome-copy">
        Pair two browsers, make a direct connection, and talk. Your messages stay in this browser
        until they can be delivered to the other side.
      </p>
      <div class="welcome-actions">
        <button class="btn btn-primary" type="button" onClick={onCreate}>
          Start a conversation ↗
        </button>
      </div>
      <div class="steps-grid">
        {steps.map((step) => (
          <article
            class="card bg-base-100 border border-base-300 shadow-none step-card"
            key={step.number}
          >
            <div class="card-body">
              <span class="badge badge-ghost step-number">{step.number}</span>
              <div class="step-icon">{step.icon}</div>
              <h3 class="card-title">{step.title}</h3>
              <p>{step.description}</p>
            </div>
          </article>
        ))}
      </div>
      <div class="footnote-row">
        <span>✓ No signup or account</span>
        <span>✓ Local message history</span>
        <span>✓ Open-source experiment</span>
      </div>
    </section>
  );
}
