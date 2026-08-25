"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { CollectionCard } from "@/components/collections/CollectionCard";
import { GameCard } from "@/components/shared/GameCard";
import { SectionHeading } from "@/components/shared/SectionHeading";
import { PlaceholderSlots } from "@/components/shared/PlaceholderSlots";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { editableSmartCollectionPreset, matchesSmartPreset, smartCollectionPresets } from "@/lib/smart-collections";
import { AddGamesDialog } from "@/components/collections/AddGamesDialog";
import type { SmartCollectionPreset } from "@/lib/types";
import styles from "./collections.module.css";

export default function CollectionsPage() {
  const { collections, games, isLive, createCollection, updateCollection, removeCollection, addGamesToCollection } = useAppData();
  const baseCollections = useMemo(() => collections.filter((collection) => collection.id !== "all"), [collections]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(baseCollections[0]?.id ?? null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [kindDraft, setKindDraft] = useState<"custom" | "smart">("smart");
  const [presetDraft, setPresetDraft] = useState<SmartCollectionPreset>("nearly-finished");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [addingGames, setAddingGames] = useState(false);
  const [addingSaving, setAddingSaving] = useState(false);
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

  async function handleCreateCollection() {
    const trimmedName = nameDraft.trim();
    if (!trimmedName) return;
    setMutationError("");
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
      setKindDraft("smart");
      setPresetDraft("nearly-finished");
      requestAnimationFrame(() => collectionRailRef.current?.scrollTo({ left: 0, behavior: "smooth" }));
    } catch (error) {
      setMutationError(collectionMutationMessage(error));
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
    setKindDraft("smart");
    setPresetDraft("nearly-finished");
    setMutationError("");
    setComposerOpen(true);
    revealComposer();
  }

  function closeComposer() {
    setComposerOpen(false);
    setEditing(false);
    setMutationError("");
  }

  function scrollCollections(direction: -1 | 1) {
    collectionRailRef.current?.scrollBy({ left: direction * 520, behavior: "smooth" });
  }

  function beginEdit() {
    if (!selectedCollection) return;
    setNameDraft(selectedCollection.name);
    setDescriptionDraft(selectedCollection.description);
    setKindDraft(selectedCollection.kind === "smart" ? "smart" : "custom");
    setPresetDraft(editableSmartCollectionPreset(selectedCollection.smartPreset));
    setMutationError("");
    setEditing(true);
    setComposerOpen(true);
    revealComposer();
  }

  async function handleUpdateCollection() {
    if (!selectedCollection || !nameDraft.trim()) return;
    setMutationError("");
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
    } catch (error) {
      setMutationError(collectionMutationMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteCollection() {
    if (!selectedCollection || !window.confirm(`Delete “${selectedCollection.name}”? Games will stay in your library.`)) return;
    setMutationError("");
    setSaving(true);
    try {
      await removeCollection(selectedCollection.id);
      setSelectedCollectionId(null);
    } catch (error) {
      setMutationError(collectionMutationMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.collectionsPage}>
      <h1 className="visually-hidden">Collections</h1>

      {!isLive ? (
        <GuestPreviewNotice feature="Collections" icon="collections" catalogueSize={ownedGames.length}>
          Explore smart shelves built from catalogue metadata, or make a temporary collection of your own. Preview changes are not saved.
        </GuestPreviewNotice>
      ) : null}

      {composerOpen ? (
        <section ref={composerRef} className={styles.composerCard} aria-labelledby="collection-composer-title">
          <h2 id="collection-composer-title" className={styles.composerTitle}>
            {editing ? `Refine ${selectedCollection?.name}` : "Build your next shelf"}
          </h2>
          <div className={styles.composerBody}>
            {/* The name is the thing you are actually deciding, so it gets the
                full width and a size to match. The two choices sit side by side
                under it, and the description — the optional part — goes last. */}
            <label className={`${styles.field} ${styles.nameField}`}>
              <span>Name</span>
              <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="Backlog Essentials" />
            </label>
            <div className={styles.composerGrid}>
              <label className={styles.field}>
                <span>Collection type</span>
                <select value={kindDraft} onChange={(event) => setKindDraft(event.target.value as "custom" | "smart")}>
                  <option value="smart">Smart collection, kept up to date</option>
                  <option value="custom">Hand-picked collection</option>
                </select>
              </label>
              <label className={styles.field}>
                <span>Automatic rule</span>
                <select
                  value={presetDraft}
                  disabled={kindDraft !== "smart"}
                  onChange={(event) => setPresetDraft(event.target.value as SmartCollectionPreset)}
                >
                  {smartCollectionPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
                </select>
                <small>{kindDraft === "smart"
                  ? smartCollectionPresets.find((preset) => preset.id === presetDraft)?.description
                  : "Only used by automatic collections."}</small>
              </label>
            </div>
            <label className={styles.field}>
              <span>Description</span>
              <input
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                placeholder="Games you want to focus on next."
              />
            </label>
            <div className={styles.composerActions}>
              <button type="button" className={styles.secondaryAction} onClick={closeComposer}>
                Cancel
              </button>
              <button type="button" className={styles.primaryAction} disabled={saving || !nameDraft.trim()} onClick={() => void (editing ? handleUpdateCollection() : handleCreateCollection())}>
                {saving ? "Saving…" : editing ? "Save Collection" : "Create Collection"}
              </button>
            </div>
            {mutationError ? <p className={styles.formError} role="alert">{mutationError}</p> : null}
          </div>
        </section>
      ) : null}

      <section className={styles.collectionPanel}>
        <SectionHeading
          title={isLive ? "Your collections" : "Preview collections"}
          meta={`${baseCollections.length}`}
          action={<>
            <div className={styles.railActions} role="group" aria-label="Browse collections">
              <button type="button" onClick={() => scrollCollections(-1)} aria-label="Previous collections"><VaultIcon name="chevron-left" /></button>
              <button type="button" onClick={() => scrollCollections(1)} aria-label="Next collections"><VaultIcon name="chevron-right" /></button>
            </div>
            <button
              type="button"
              className={styles.primaryAction}
              aria-expanded={composerOpen}
              onClick={composerOpen ? closeComposer : openNewComposer}
            >
              <VaultIcon name="new-collection" size={20} />
              {composerOpen ? "Close" : "New collection"}
            </button>
          </>}
        />
        <div ref={collectionRailRef} className={styles.collectionGrid} role="region" tabIndex={0} aria-label="Your collections">
          {baseCollections.length ? null : (
            <PlaceholderSlots
              count={3}
              size="wide"
              label="No shelves yet. A collection is any group of your games — by mood, by series, by whatever you like."
              action={<button type="button" className={styles.placeholderAction} onClick={openNewComposer}>New collection</button>}
            />
          )}
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
          <SectionHeading
            title="Selected collection"
            meta={selectedCollection.name}
            action={<div className={styles.selectedActions}>
              {selectedCollection.kind === "smart" ? null : (
                <button type="button" className={styles.primaryAction} onClick={() => setAddingGames(true)}>
                  <VaultIcon name="add-game" size={18} />Add games
                </button>
              )}
              <button type="button" className={styles.secondaryAction} onClick={beginEdit}>Edit</button>
              <button type="button" className={`${styles.secondaryAction} ${styles.dangerAction}`} disabled={saving} onClick={() => void handleDeleteCollection()}>Delete</button>
            </div>}
          />
          {!composerOpen && mutationError ? <p className={styles.formError} role="alert">{mutationError}</p> : null}
          <div className={styles.selectedGames}>
            {selectedGames.length ? (
              selectedGames.map((game) => <GameCard key={game.id} game={game} />)
            ) : (
              <PlaceholderSlots
                count={4}
                label={selectedCollection.kind === "smart"
                  ? (isLive ? "Nothing matches this rule yet." : "No preview games match this rule yet.")
                  : "Nothing on this shelf yet. Add games works from here."}
                action={<button type="button" className={styles.placeholderAction} onClick={() => setAddingGames(true)}>Add games</button>}
              />
            )}
          </div>
        </section>
      ) : null}

      {addingGames && selectedCollection ? (
        <AddGamesDialog
          collectionName={selectedCollection.name}
          games={ownedGames}
          alreadyIn={new Set(selectedGames.map((game) => game.id))}
          saving={addingSaving}
          onClose={() => setAddingGames(false)}
          onAdd={async (gameIds) => {
            setAddingSaving(true);
            try {
              await addGamesToCollection(selectedCollection.id, gameIds);
              setAddingGames(false);
            } catch (error) {
              setMutationError(collectionMutationMessage(error));
            } finally {
              setAddingSaving(false);
            }
          }}
        />
      ) : null}
    </section>
  );
}

function collectionMutationMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "We couldn't save that collection. Please try again.";
}
