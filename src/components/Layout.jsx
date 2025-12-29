import React from 'react';

export function Layout({ children, sidebar, properties }) {
    return (
        <div className="flex h-screen w-full overflow-hidden bg-ios-gray p-4 gap-4">
            {/* Left Sidebar - Tools */}
            <aside className="w-20 flex-shrink-0 flex flex-col items-center py-6 bg-white/60 backdrop-blur-glass-40 rounded-ios-lg shadow-soft-spread border border-white/60">
                {sidebar}
            </aside>

            {/* Main Content - Canvas */}
            <main className="flex-1 relative flex flex-col bg-white/40 backdrop-blur-glass-40 rounded-ios-lg shadow-soft-spread border border-white/60 overflow-hidden">
                {children}
            </main>

            {/* Right Sidebar - Properties */}
            <aside className="w-96 flex-shrink-0 flex flex-col bg-white/60 backdrop-blur-glass-40 rounded-ios-lg shadow-soft-spread border border-white/60 overflow-y-auto">
                {properties}
            </aside>
        </div>
    );
}
