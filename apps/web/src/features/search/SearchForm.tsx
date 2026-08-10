import { useState, type FormEvent } from "react";

import type { EventSearchQuery } from "@event-agg/core";

interface SearchFormProps {
  isSearching: boolean;
  onSearch(query: EventSearchQuery): Promise<void>;
  onStop(): Promise<void>;
}

export function SearchForm({ isSearching, onSearch, onStop }: SearchFormProps) {
  const [locationText, setLocationText] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSearch({ locationText, startDate, endDate, timeZone });
  }

  return (
    <form className="search-form" onSubmit={(event) => void submit(event)}>
      <label className="location-field">
        <span>Location</span>
        <input
          required
          value={locationText}
          onChange={(event) => setLocationText(event.target.value)}
          placeholder="City or address"
        />
      </label>
      <label>
        <span>Start date</span>
        <input
          required
          type="date"
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
        />
      </label>
      <label>
        <span>End date</span>
        <input
          required
          type="date"
          value={endDate}
          onChange={(event) => setEndDate(event.target.value)}
        />
      </label>
      <label>
        <span>Timezone</span>
        <input
          required
          value={timeZone}
          onChange={(event) => setTimeZone(event.target.value)}
        />
      </label>
      {isSearching ? (
        <button className="secondary-button" type="button" onClick={() => void onStop()}>
          Stop
        </button>
      ) : (
        <button className="primary-button" type="submit">
          Search
        </button>
      )}
    </form>
  );
}

