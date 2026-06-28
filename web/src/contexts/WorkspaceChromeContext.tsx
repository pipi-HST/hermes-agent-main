import { createContext, useContext, type Dispatch, type ReactNode, type SetStateAction } from "react";

interface WorkspaceChromeContextValue {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
}

const WorkspaceChromeContext = createContext<WorkspaceChromeContextValue | null>(null);

export function WorkspaceChromeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WorkspaceChromeContextValue;
}) {
  return (
    <WorkspaceChromeContext.Provider value={value}>
      {children}
    </WorkspaceChromeContext.Provider>
  );
}

export function useWorkspaceChrome(): WorkspaceChromeContextValue {
  const context = useContext(WorkspaceChromeContext);
  if (!context) {
    throw new Error("useWorkspaceChrome must be used within WorkspaceChromeProvider");
  }
  return context;
}
