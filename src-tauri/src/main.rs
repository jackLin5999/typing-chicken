// Prevents an additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    da_zi_ji_lib::run()
}
