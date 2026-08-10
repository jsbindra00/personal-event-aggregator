import { useEffect, useState } from "react";

import type { InterestProfile } from "@event-agg/core";

interface InterestEditorProps {
  profile: InterestProfile;
  onSave(profile: InterestProfile): Promise<void>;
}

function lines(value: string): string[] {
  return [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
}

export function InterestEditor({ profile, onSave }: InterestEditorProps) {
  const [positive, setPositive] = useState(profile.positive.join("\n"));
  const [excluded, setExcluded] = useState(profile.excluded.join("\n"));
  const [note, setNote] = useState(profile.note);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPositive(profile.positive.join("\n"));
    setExcluded(profile.excluded.join("\n"));
    setNote(profile.note);
  }, [profile]);

  async function save() {
    await onSave({ positive: lines(positive), excluded: lines(excluded), note: note.trim() });
    setSaved(true);
  }

  return (
    <details className="interest-panel">
      <summary>
        <span>Interest profile</span>
        <small>{profile.positive.length} saved interests</small>
      </summary>
      <div className="interest-grid">
        <label>
          <span>Interested in · one per line</span>
          <textarea value={positive} onChange={(event) => setPositive(event.target.value)} />
        </label>
        <label>
          <span>Exclude · one per line</span>
          <textarea value={excluded} onChange={(event) => setExcluded(event.target.value)} />
        </label>
        <label className="interest-note">
          <span>What makes an event worth attending?</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
      </div>
      <button className="secondary-button" type="button" onClick={() => void save()}>
        {saved ? "Saved" : "Save interests"}
      </button>
    </details>
  );
}

