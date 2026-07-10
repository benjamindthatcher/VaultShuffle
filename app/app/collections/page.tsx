"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { CollectionCard } from "@/components/collections/CollectionCard";
import { GameCard } from "@/components/shared/GameCard";
import { StatCard } from "@/components/shared/StatCard";
import { matchesSmartPreset, smartCollectionPresets } from "@/lib/smart-collections";
import type { SmartCollectionPreset } from "@/lib/types";
import styles from "./collections.module.css";

export default function CollectionsPage() {
  const { collections, games, createCollection, updateCollection, removeCollection } = useAppData();
  const baseCollections = useMemo(() => collections.filter((collection) => collection.id !== "all"), [collections]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(baseCollections[0]?.id ?? null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [kindDraft, setKindDraft] = useState<"custom" | "smart">("custom");
  const [presetDraft, setPresetDraft] = useState<SmartCollectionPreset>("backlog");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const ownedGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);

  useEffect(() => {
    if (!baseCollections.length) return;
    if (!selectedCollectionId || !baseCollections.some((collection) => collection.id === selectedCollectionId)) {
      setSelectedCollectionId(baseCollections[0].id);
    }
  }, [baseCollections, selectedCollectionId]);

  const collectionGameMap = useMemo(
    () =>
      new Map(
        baseCollections.map((collection) => [
          collection.id,
          ownedGames.filter((game) => collection.kind === "smart" && collection.smartPreset
            ? matchesSmartPreset(game, collection.smartPreset)
            : game.collectionIds.includes(collection.id))
        ])
      ),
    [baseCollections, ownedGames]
  );

  const selectedCollection = baseCollections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const selectedGames = selectedCollection ? collectionGameMap.get(selectedCollection.id) ?? [] : [];

  const stats = useMemo(
    () => {
      const collectedIds = new Set([...collectionGameMap.values()].flat().map((game) => game.id));
      return {
        total: baseCollections.length,
        smart: baseCollections.filter((collection) => collection.kind === "smart").length,
        custom: baseCollections.filter((collection) => collection.kind === "custom").length,
        inCollections: collectedIds.size
      };
    },
    [baseCollections, collectionGameMap]
  );

  async function handleCreateCollection() {
    const trimmedName = nameDraft.trim();
    if (!trimmedName) return;
    await createCollection({
      name: trimmedName,
      description: descriptionDraft.trim(),
      kind: kindDraft,
      rules: kindDraft === "smart" ? { preset: presetDraft } : undefined
    });
    setComposerOpen(false);
    setNameDraft("");
    setDescriptionDraft("");
    setKindDraft("custom");
    setPresetDraft("backlog");
  }

  function beginEdit() {
    if (!selectedCollection) return;
    setNameDraft(selectedCollection.name);
    setDescriptionDraft(selectedCollection.description);
    setKindDraft(selectedCollection.kind === "smart" ? "smart" : "custom");
    setPresetDraft(selectedCollection.smartPreset || "backlog");
    setEditing(true);
    setComposerOpen(true);
  }

  async function handleUpdateCollection() {
    if (!selectedCollection || !nameDraft.trim()) return;
    setSaving(true);
    try {
      await updateCollection(selectedCollection.id, {
        name: nameDraft.trim(),
        description: descriptionDraft.trim(),
        kind: kindDraft,
        rules: kindDraft === "smart" ? { preset: presetDraft } : undefined
      });
      setComposerOpen(false);
      setEditing(false);
      setNameDraft("");
      setDescriptionDraft("");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCollection() {
    if (!selectedCollection || !window.confirm(`Delete “${selectedCollection.name}”? Games will stay in your library.`)) return;
    setSaving(true);
    try {
      await removeCollection(selectedCollection.id);
      setSelectedCollectionId(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.collectionsPage}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Collections</p>
          <h1 className={styles.title}>Collections</h1>
          <p className={styles.description}>Create, organise and play your way.</p>
        </div>
        <button type="button" className={styles.primaryAction} onClick={() => { setEditing(false); setNameDraft(""); setDescriptionDraft(""); setKindDraft("custom"); setPresetDraft("backlog"); setComposerOpen((current) => !current); }}>
          New Collection
        </button>
      </header>

      {composerOpen ? (
        <section className={styles.composerCard}>
          <div className={styles.composerGrid}>
            <label className={styles.field}>
              <span>Name</span>
              <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="Backlog Essentials" />
            </label>
            <label className={styles.field}>
              <span>Collection type</span>
              <select value={kindDraft} onChange={(event) => setKindDraft(event.target.value as "custom" | "smart")}>
                <option value="custom">Custom collection</option>
                <option value="smart">Smart collection</option>
              </select>
            </label>
            {kindDraft === "smart" ? (
              <label className={styles.field}>
                <span>Automatic rule</span>
                <select value={presetDraft} onChange={(event) => setPresetDraft(event.target.value as SmartCollectionPreset)}>
                  {smartCollectionPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                </select>
                <small>{smartCollectionPresets.find((preset) => preset.id === presetDraft)?.description}</small>
              </label>
            ) : null}
            <label className={styles.field}>
              <span>Description</span>
              <input
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                placeholder="Games you want to focus on next."
              />
            </label>
          </div>
          <div className={styles.composerActions}>
            <button type="button" className={styles.secondaryAction} onClick={() => { setComposerOpen(false); setEditing(false); }}>
              Cancel
            </button>
            <button type="button" className={styles.primaryAction} disabled={saving} onClick={() => void (editing ? handleUpdateCollection() : handleCreateCollection())}>
              {saving ? "Saving…" : editing ? "Save Collection" : "Create Collection"}
            </button>
          </div>
        </section>
      ) : null}

      <div className={styles.statsGrid}>
        <StatCard label="All Collections" value={stats.total} note="Every shelf currently in rotation." />
        <StatCard label="Smart Collections" value={stats.smart} note="Automatically themed groupings." />
        <StatCard label="Custom Collections" value={stats.custom} note="Hand-shaped shelves with your own intent." />
        <StatCard label="Games in Collections" value={stats.inCollections} note="Owned games already sorted into groups." />
      </div>

      <section className={styles.collectionPanel}>
        <h2 className={styles.collectionPanelTitle}>Your Collections</h2>
        <div className={styles.collectionGrid}>
          {baseCollections.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              previewGames={collectionGameMap.get(collection.id) ?? []}
              onSelect={() => setSelectedCollectionId(collection.id)}
            />
          ))}
        </div>
      </section>

      {selectedCollection ? (
        <section className={styles.selectedPanel}>
          <div className={styles.selectedHeader}>
            <div>
              <p className={styles.sectionEyebrow}>Selected collection</p>
              <h2 className={styles.sectionTitle}>{selectedCollection.name}</h2>
              <p className={styles.sectionCopy}>{selectedCollection.description}</p>
              {selectedCollection.kind === "smart" ? <p className={styles.ruleNote}>Updates automatically from your library.</p> : null}
            </div>
            <div className={styles.selectedActions}>
              <button type="button" className={styles.secondaryAction} onClick={beginEdit}>Edit</button>
              <button type="button" className={`${styles.secondaryAction} ${styles.dangerAction}`} disabled={saving} onClick={() => void handleDeleteCollection()}>Delete</button>
            </div>
          </div>
          <div className={styles.selectedGames}>
            {selectedGames.length ? (
              selectedGames.map((game) => <GameCard key={game.id} game={game} />)
            ) : (
              <div className={styles.emptyState}>
                <h3 className={styles.emptyTitle}>No games in this collection yet.</h3>
                <p className={styles.emptyCopy}>{selectedCollection.kind === "smart"
                  ? "No owned games currently match this automatic rule."
                  : "Open a game from Library and select this collection to add it here."}</p>
              </div>
            )}
          </div>
        </section>
      ) : null}
    </section>
  );
}
