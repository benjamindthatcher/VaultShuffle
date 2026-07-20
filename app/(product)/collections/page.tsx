"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { CollectionCard } from "@/components/collections/CollectionCard";
import { GameCard } from "@/components/shared/GameCard";
import { StatCard } from "@/components/shared/StatCard";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { BrandedIcon } from "@/components/shared/BrandedIcon";
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
  const composerRef = useRef<HTMLElement>(null);
  const collectionRailRef = useRef<HTMLDivElement>(null);

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
    setSaving(true);
    try {
      const collectionId = await createCollection({
        name: trimmedName,
        description: descriptionDraft.trim(),
        kind: kindDraft,
        rules: kindDraft === "smart" ? { preset: presetDraft } : undefined
      });
      setSelectedCollectionId(collectionId);
      setComposerOpen(false);
      setNameDraft("");
      setDescriptionDraft("");
      setKindDraft("custom");
      setPresetDraft("backlog");
      requestAnimationFrame(() => collectionRailRef.current?.scrollTo({ left: 0, behavior: "smooth" }));
    } finally {
      setSaving(false);
    }
  }

  function revealComposer() {
    requestAnimationFrame(() => composerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  function openNewComposer() {
    setEditing(false);
    setNameDraft("");
    setDescriptionDraft("");
    setKindDraft("custom");
    setPresetDraft("backlog");
    setComposerOpen(true);
    revealComposer();
  }

  function closeComposer() {
    setComposerOpen(false);
    setEditing(false);
  }

  function scrollCollections(direction: -1 | 1) {
    collectionRailRef.current?.scrollBy({ left: direction * 520, behavior: "smooth" });
  }

  function beginEdit() {
    if (!selectedCollection) return;
    setNameDraft(selectedCollection.name);
    setDescriptionDraft(selectedCollection.description);
    setKindDraft(selectedCollection.kind === "smart" ? "smart" : "custom");
    setPresetDraft(selectedCollection.smartPreset || "backlog");
    setEditing(true);
    setComposerOpen(true);
    revealComposer();
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
        <h1 className="visually-hidden">Collections</h1>
        <button type="button" className={styles.primaryAction} onClick={openNewComposer}>
          <BrandedIcon group="actions" name="new-collection" size={25} /> New Collection
        </button>
      </header>

      {composerOpen ? (
        <section ref={composerRef} className={styles.composerCard} aria-labelledby="collection-composer-title">
          <div className={styles.composerHeader}>
            <div>
              <p className={styles.sectionEyebrow}>{editing ? "Editing collection" : "Create a collection"}</p>
              <h2 id="collection-composer-title" className={styles.composerTitle}>{editing ? `Refine ${selectedCollection?.name}` : "Build your next shelf"}</h2>
              <p className={styles.composerCopy}>{editing
                ? "Update its identity or change how its games are gathered."
                : "Choose a hand-picked shelf or an automatic collection that stays current for you."}</p>
            </div>
          </div>
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
            <button type="button" className={styles.secondaryAction} onClick={closeComposer}>
              Cancel
            </button>
            <button type="button" className={styles.primaryAction} disabled={saving || !nameDraft.trim()} onClick={() => void (editing ? handleUpdateCollection() : handleCreateCollection())}>
              {saving ? "Saving…" : editing ? "Save Collection" : "Create Collection"}
            </button>
          </div>
        </section>
      ) : null}

      <div className={styles.statsGrid}>
        <StatCard icon="all-collections" label="All Collections" value={stats.total} note="Every shelf currently in rotation." />
        <StatCard icon="smart-collections" label="Smart Collections" value={stats.smart} note="Automatically themed groupings." />
        <StatCard icon="custom-collections" label="Custom Collections" value={stats.custom} note="Hand-shaped shelves with your own intent." />
        <StatCard icon="games-in-collections" label="Games in Collections" value={stats.inCollections} note="Owned games already sorted into groups." />
      </div>

      <section className={styles.collectionPanel}>
        <div className={styles.collectionPanelHeader}>
          <div>
            <h2 className={styles.collectionPanelTitle}>Your Collections</h2>
            <p className={styles.collectionPanelCopy}>Browse every shelf in your vault.</p>
          </div>
          <div className={styles.railActions} aria-label="Browse collections">
            <button type="button" onClick={() => scrollCollections(-1)} aria-label="Previous collections"><VaultIcon name="chevron-left" /></button>
            <button type="button" onClick={() => scrollCollections(1)} aria-label="Next collections"><VaultIcon name="chevron-right" /></button>
          </div>
        </div>
        <div ref={collectionRailRef} className={styles.collectionGrid} tabIndex={0} aria-label="Your collections">
          {baseCollections.map((collection) => (
            <CollectionCard
              key={collection.id}
              collection={collection}
              previewGames={collectionGameMap.get(collection.id) ?? []}
              selected={collection.id === selectedCollectionId}
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
