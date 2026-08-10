import { useEffect, useMemo, useState } from "react";

import type { ConnectorStatus, EventSource, InterestProfile } from "@event-agg/core";

import { InterestEditor } from "./features/interests/InterestEditor.js";
import { EventResults } from "./features/search/EventResults.js";
import { RelevanceStatus } from "./features/search/RelevanceStatus.js";
import { SearchForm } from "./features/search/SearchForm.js";
import { SourceStatus } from "./features/search/SourceStatus.js";
import { useEventSearch } from "./features/search/useEventSearch.js";
import type { EventApi } from "./lib/api.js";

interface AppProps {
  api: EventApi;
}

const emptyProfile: InterestProfile = { positive: [], excluded: [], note: "" };

export function App({ api }: AppProps) {
  const [profile, setProfile] = useState(emptyProfile);
  const [baseStatuses, setBaseStatuses] = useState<
    Partial<Record<EventSource, ConnectorStatus>>
  >({});
  const search = useEventSearch(api);

  useEffect(() => {
    void api.getInterests().then(setProfile);
    void api.getConnectors().then((statuses) => {
      setBaseStatuses(
        Object.fromEntries(statuses.map((status) => [status.source, status]))
      );
    });
  }, [api]);

  const statuses = useMemo(
    () => ({ ...baseStatuses, ...search.sourceStatuses }),
    [baseStatuses, search.sourceStatuses]
  );

  async function saveProfile(next: InterestProfile) {
    setProfile(await api.setInterests(next));
  }

  async function connectSource(source: EventSource) {
    await api.connectSource(source);
    const next = await api.getConnectors();
    setBaseStatuses(
      Object.fromEntries(next.map((status) => [status.source, status]))
    );
  }

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">Personal event intelligence</p>
          <h1>Find the rooms<br />worth entering.</h1>
          <p className="hero-copy">
            One search across Meetup, Luma, Guild and Eventbrite—ranked around what you actually care about.
          </p>
        </div>
        <div className="radar-mark" aria-hidden="true"><span /></div>
      </header>

      <InterestEditor profile={profile} onSave={saveProfile} />

      <section className="search-shell">
        <SearchForm
          isSearching={search.phase === "searching"}
          onSearch={search.start}
          onStop={search.stop}
        />
        <SourceStatus statuses={statuses} onConnect={connectSource} />
      </section>

      <section className="results-section">
        <div className="results-heading">
          <div>
            <p className="eyebrow">Live results</p>
            <h2>{search.events.length > 0 ? `${search.events.length} events found` : "Your event feed"}</h2>
          </div>
          <span className={`phase-indicator phase-${search.phase}`}>{search.phase}</span>
        </div>
        {search.error && <p className="error-banner">{search.error}</p>}
        <RelevanceStatus status={search.relevance} />
        <EventResults events={search.events} searching={search.phase === "searching"} />
        {search.maybeEvents.length > 0 && (
          <details className="maybe-results">
            <summary>Maybe ({search.maybeEvents.length})</summary>
            <EventResults events={search.maybeEvents} searching={false} />
          </details>
        )}
      </section>
    </main>
  );
}
