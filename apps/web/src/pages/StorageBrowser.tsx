// The folders of a cloud storage connection (S3, Azure, Google Cloud Storage): open folders, see
// each file's size, open a file as a query, read a whole folder at once, or import a file as a dataset.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../context";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import type { StorageFolder } from "../types";

function size(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function stem(name: string): string {
  return name.replace(/\.(parquet|pq|csv|tsv|txt|json|jsonl|ndjson)(\.gz)?$/i, "") || name;
}

export function StorageBrowser({ connectionId, onOpen, onInsert, onImport }: {
  connectionId: string;
  /** Show a file (or every file of a folder) in the editor and run it. */
  onOpen: (reader: string) => void;
  /** Put the SQL that reads a file at the editor's cursor. */
  onInsert: (reader: string) => void;
  /** Save a whole file as a dataset, named after it. */
  onImport: (reader: string, name: string) => void;
}) {
  const { engine } = useApp();
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<StorageFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (path: string) => {
      setLoading(true);
      setError(null);
      engine
        .call<StorageFolder>("sql.storage_browse", { connection_id: connectionId, folder: path })
        .then((found) => {
          setListing(found);
          setFolder(found.folder);
        }, (failure: Error) => setError(failure.message))
        .finally(() => setLoading(false));
    },
    [engine, connectionId],
  );

  useEffect(() => {
    setListing(null);
    load("");
  }, [load]);

  const parts = folder ? folder.split("/") : [];
  const place = listing ? listing.root.replace(/\/$/, "").split("/").pop() : "";

  if (error && !listing) {
    return (
      <div className="sql-empty">
        <p className="error-text small">{error}</p>
        <button className="small" onClick={() => load(folder)}>
          Try again
        </button>
      </div>
    );
  }
  if (!listing) return <Spinner />;
  return (
    <div className="storage" aria-busy={loading}>
      <nav className="storage-path" aria-label="Folder">
        <button className="ghost small" onClick={() => load("")} disabled={loading} title={listing.root}>
          <Icon name="server" size={11} /> {place}
        </button>
        {parts.map((part, i) => (
          <span key={i} className="storage-crumb">
            <Icon name="chevronRight" size={10} className="faint" />
            <button className="ghost small" onClick={() => load(parts.slice(0, i + 1).join("/"))} disabled={loading || i === parts.length - 1}>
              {part}
            </button>
          </span>
        ))}
        {loading && <Spinner />}
        <span className="spacer" />
        <button className="ghost icon-only small" onClick={() => load(folder)} disabled={loading} aria-label="Refresh this folder">
          <Icon name="refresh" size={11} />
        </button>
      </nav>
      {error && <p className="error-text small sql-empty">{error}</p>}
      {listing.all_files_sql && (
        <button className="small storage-all" onClick={() => onOpen(listing.all_files_sql!)} title="One table from every file in this folder (columns matched by name)">
          <Icon name="layers" size={12} /> Query all {listing.files.filter((f) => f.format).length} files together
        </button>
      )}
      <ul className="storage-list">
        {folder && (
          <li>
            <button className="storage-item" onClick={() => load(parts.slice(0, -1).join("/"))} disabled={loading}>
              <Icon name="arrowUp" size={12} className="faint" />
              <span className="storage-name plain">Up one folder</span>
            </button>
          </li>
        )}
        {listing.folders.map((f) => (
          <li key={f.name}>
            <button className="storage-item" onClick={() => load(folder ? `${folder}/${f.name}` : f.name)} disabled={loading}>
              <Icon name="folder" size={12} className="accent-text" />
              <span className="storage-name">{f.name}</span>
              <span className="faint tiny num">
                {f.files.toLocaleString()}
                {listing.truncated ? "+" : ""} {f.files === 1 && !listing.truncated ? "file" : "files"}
              </span>
            </button>
          </li>
        ))}
        {listing.files.map((f) => (
          <li key={f.path} className="storage-file">
            <button
              className="storage-item"
              onClick={() => f.sql && onOpen(f.sql)}
              disabled={!f.sql}
              title={f.sql ? `Show the first rows of ${f.name}` : "FlowLabs reads Parquet, CSV and JSON files"}
            >
              <Icon name={f.sql ? "table" : "file"} size={12} className="faint" />
              <span className="storage-name">{f.name}</span>
              <span className="faint tiny num nowrap">{size(f.size)}</span>
            </button>
            {f.sql && (
              <span className="storage-actions">
                <button className="ghost icon-only small" onClick={() => onInsert(f.sql!)} aria-label={`Insert the SQL that reads ${f.name}`} title="Insert into the query">
                  <Icon name="code" size={11} />
                </button>
                <button className="ghost icon-only small" onClick={() => onImport(f.sql!, stem(f.name))} aria-label={`Import ${f.name} as a dataset`} title="Import as a dataset">
                  <Icon name="download" size={11} />
                </button>
              </span>
            )}
          </li>
        ))}
        {listing.folders.length === 0 && listing.files.length === 0 && <li className="faint small sql-empty">This folder is empty.</li>}
      </ul>
      {listing.truncated && <p className="faint tiny sql-empty">A very large folder: the first 5,000 files are counted.</p>}
    </div>
  );
}
