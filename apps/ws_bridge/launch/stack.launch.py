"""Bring up the whole robot-twin stack: Franka hardware, ros2_control,
MoveIt move_group, and the ws_bridge.

Usage (on the NUC, from the workspace root):
    ros2 launch ws_bridge stack.launch.py

The controller names and the robot-description source must match your
franka_ros2 install / URDF. See deploy/DEPLOY.md for the values to check.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch_ros.actions import Node
from launch.substitutions import LaunchConfiguration


def generate_launch_description():
    # Franka hardware + ros2_control. `franka_bringup` (in franka_ros2) launches
    # the controller manager, the joint_state_broadcaster and the
    # joint_trajectory_controller with the robot_description from the URDF.
    franka_share = get_package_share_directory("franka_bringup")
    franka_launch = os.path.join(franka_share, "launch", "franka.launch.py")

    # MoveIt move_group (planning + collision). `franka_moveit_config` in
    # franka_ros2 provides a moveit.launch.py with the Panda SRDF / kinematics.
    moveit_share = get_package_share_directory("franka_moveit_config")
    moveit_launch = os.path.join(moveit_share, "launch", "moveit.launch.py")

    return LaunchDescription(
        [
            DeclareLaunchArgument("robot_ip", default_value="192.168.1.4",
                                  description="IP of the Panda control unit (FCI)"),
            DeclareLaunchArgument("use_rviz", default_value="false",
                                  description="Launch RViz alongside MoveIt"),
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(franka_launch),
                launch_arguments={"robot_ip": LaunchConfiguration("robot_ip")}.items(),
            ),
            IncludeLaunchDescription(
                PythonLaunchDescriptionSource(moveit_launch),
                launch_arguments={"use_rviz": LaunchConfiguration("use_rviz")}.items(),
            ),
            # WebSocket bridge for the twin.
            Node(
                package="ws_bridge",
                executable="ws_bridge",
                name="ws_bridge",
                output="screen",
            ),
        ]
    )
