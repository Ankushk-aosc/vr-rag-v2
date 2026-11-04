import React from "react";
import * as THREE from "three";
import { TableViewerModal } from "./TableViewerModal";
import { DocumentDrawer } from "./DocumentDrawer";
import { VrLaunchModal } from "./VrLaunchModal";
import { StereoViewer } from "./StereoViewer";
import { DocumentRecord } from "../types";
import { SpatialState } from "../lib/spatial/spatialPanels";
import { enterImmersiveVr } from "../lib/webxr";
import { FamilyRole } from "../lib/roles";
import type { SovereignNavView } from "./Header";

interface AppModalsProps {
  theme: "light" | "dark";
  selectedTableDoc: DocumentRecord | null;
  onCloseTableDoc: () => void;
  isDocDrawerOpen: boolean;
  onCloseDocDrawer: () => void;
  documents: DocumentRecord[];
  onDocumentUploaded: () => void;
  selectedEntity: string;
  entityLabel?: string;
  role: FamilyRole;
  /** Shown when an immersive VR session could not start. */
  onVrError: (message: string) => void;
  isVrModalOpen: boolean;
  onCloseVrModal: () => void;
  rendererRef: React.MutableRefObject<THREE.WebGLRenderer | null>;
  activeView: SovereignNavView;
  setActiveView: (view: SovereignNavView) => void;
  isStereoOpen: boolean;
  setIsStereoOpen: (open: boolean) => void;
  spatialStateRef: React.MutableRefObject<SpatialState>;
  onOrbTap: () => void;
  onSelectDocument: (doc: DocumentRecord) => void;
  onCreateDashboard: () => void;
  onCloseDashboard: () => void;
}

export function AppModals({
  theme,
  selectedTableDoc,
  onCloseTableDoc,
  isDocDrawerOpen,
  onCloseDocDrawer,
  documents,
  onDocumentUploaded,
  selectedEntity,
  entityLabel,
  role,
  onVrError,
  isVrModalOpen,
  onCloseVrModal,
  rendererRef,
  activeView,
  setActiveView,
  isStereoOpen,
  setIsStereoOpen,
  spatialStateRef,
  onOrbTap,
  onSelectDocument,
  onCreateDashboard,
  onCloseDashboard,
}: AppModalsProps) {
  return (
    <>
      <TableViewerModal
        document={selectedTableDoc}
        onClose={onCloseTableDoc}
        theme={theme}
      />

      <DocumentDrawer
        isOpen={isDocDrawerOpen}
        onClose={onCloseDocDrawer}
        documents={documents}
        onDocumentUploaded={onDocumentUploaded}
        selectedEntity={selectedEntity}
        entityLabel={entityLabel}
        role={role}
        theme={theme}
      />

      <VrLaunchModal
        isOpen={isVrModalOpen}
        onClose={onCloseVrModal}
        onEnterWebXr={() => {
          if (activeView !== "spatial") setActiveView("spatial");
          if (!rendererRef.current) {
            onVrError("The Spatial Room is still loading. Select Enter VR again once it appears.");
            return;
          }
          enterImmersiveVr(rendererRef.current).catch(() => {
            onVrError("VR could not start on this device. You can continue in the Spatial Room in desktop mode.");
          });
        }}
        onLaunchStereo={() => setIsStereoOpen(true)}
        onOpenSpatial={() => setActiveView("spatial")}
        theme={theme}
      />

      <StereoViewer
        isOpen={isStereoOpen}
        onClose={() => setIsStereoOpen(false)}
        documents={documents}
        stateRef={spatialStateRef}
        onOrbTap={onOrbTap}
        onSelectDocument={onSelectDocument}
        onCreateDashboard={onCreateDashboard}
        onCloseDashboard={onCloseDashboard}
      />
    </>
  );
}
