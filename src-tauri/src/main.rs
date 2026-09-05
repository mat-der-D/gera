// Keep a console window from appearing behind the GUI app in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gera_lib::run()
}
